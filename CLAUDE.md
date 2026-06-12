# SISO / WMS — Sistema Inteligente de Separação de Ordens

App fullstack que substitui um workflow n8n para processar pedidos multi-empresa de autopeças. Empresas (Tiny ERP, cada uma com seu CNPJ) vendem em marketplaces (Mercado Livre, Shopee). Quando um pedido chega via webhook do Tiny, o sistema checa estoque (fonte única WMS), roteia (própria / transferência / OC) e auto-aprova ou manda pro painel humano. Cobre o pós-aprovação inteiro: separação (wave picking), embalagem, etiqueta, compras (OC), recebimento, guarda (put-away), inventário, devoluções e expedição.

**Volume:** ~500 pedidos/dia. Tudo vive sob o módulo **`/wms`**.

---

## ⚠️ Working Environment (LEIA PRIMEIRO)

**Trabalhamos exclusivamente em staging.** Toda mudança de schema, RPC, dado de teste ou query exploratória vai pra staging — nunca toque em prod sem pedido explícito.

| | Branch | Supabase project | Estado |
|---|---|---|---|
| **Staging (ativo)** | `develop` → `estoquelever.vercel.app` | `ehbxpbeijofxtsbezwxd` | **fonte da verdade** |
| Prod (dormente) | `main` | `wrbrbhuhsaaupqsimkqz` | não tocar |

- O `.env` ativo aponta pra `ehbxpbeijofxtsbezwxd` (a linha do prod está comentada).
- Vercel rotula deploys da `develop` como `Environment: production` — isso é só o "published deployment", **não** é prod-real. Confiar na **branch**, não no rótulo.
- Migrations: criar arquivo em `supabase/migrations/` + aplicar via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd`.

---

## Stack

- **Framework:** Next.js `16.1.6` (App Router, `output: "standalone"`) · React `19.2.3` · TypeScript `5.9.3` (`strict`, alias `@/* → ./src/*`)
- **Styling:** Tailwind CSS 4 **CSS-first** (sem `tailwind.config.*`; tokens em `@theme inline` dentro de `src/app/globals.css`) + design system manual `wms-*` em `src/app/wms/wms.css`. Sem component library — tudo custom.
- **DB:** Supabase (`@supabase/supabase-js`). Server usa **service role** (`createServiceClient()`), bypassa RLS.
- **State client:** TanStack React Query (sem store global). Realtime via Supabase Realtime + Presence.
- **Validação:** Zod. **Toasts:** Sonner. **Ícones:** Lucide (+ alguns SVGs inline em `wms-ui.tsx`).
- **Fonts:** Outfit (sans) + JetBrains Mono (mono).
- **Integrações:** Tiny ERP API v3 (OAuth2/Keycloak) · Mercado Livre (OAuth2) · PrintNode (etiquetas ZPL/PDF, multi-conta).

### Comandos

```bash
npm run dev              # dev server
npm run build / start    # produção
npm run lint             # ESLint (flat config)
npm test                 # vitest unit (happy-dom)
npm run test:integration # vitest contra staging real (serializado, trunca tabelas operacionais)
npm run scenarios        # E2E HTTP em /api/wms/* (run-all.ts); :only, :ci (--prod)
npm run auth-matrix      # matriz de auth/permissões
# seeds/utils: seed:cross, seed:staging, seed:cenarios, fake:webhook, verificar:saldos, notify:stock
```

> ⚠️ **integration + scenarios rodam contra o staging real e truncam tabelas operacionais antes de cada run.** Nunca apontar pra prod.
> 🔒 **O staging é ambiente VIVO (pedidos reais)** — desde 2026-06-11 todo wipe (truncate do harness + `seed:staging`) exige `ALLOW_STAGING_WIPE=true` no env, senão aborta. O cron diário do GitHub Actions (`wms-stock-suite`) foi removido — a suite só roda via dispatch manual. **NUNCA setar a flag sem o Eryk pedir explicitamente.**

### Environment variables (só nomes — nunca commitar valores)

**Obrigatórias:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server; cai pra anon key se ausente — degrada silenciosamente pra RLS).
**Opcionais:** `WORKER_SECRET` (protege worker + crons), `TINY_DISABLED` / `PRINTNODE_DISABLED` / `ML_DISABLED` (roteiam pros stubs locais; default `false`), `TINY_RATE_LIMIT_PER_MIN` (55), `TINY_MAX_CONCURRENT` (5).
**Stubs:** com `*_DISABLED=true`, `tiny-api`/`printnode`/`ml-api` roteiam pra `tiny-stub`/`printnode-stub`/`ml-stub` (lêem `siso_*`, writes retornam IDs fake).

---

## Arquitetura & Pipeline

```
Tiny webhook (pedido)
  → api/wms/webhook/tiny           valida, dedup (siso_webhook_logs), CNPJ→empresa, discrimina pedido vs nota_fiscal
    (fallback: cron 10min → api/wms/tiny/polling → tiny-polling.ts varre os Tinys conectados de empresas ATIVAS (siso_empresas.ativo; inativa = pulada + webhook 400 via empresa-lookup):
     retry de webhooks falhos (logs erro/presos >1h re-tentam reutilizando o log, qualquer tipo) + pedidos aprovados (janela 30d por data de CRIAÇÃO) + cancelados/NFs (janela 7d))
  → processWebhook                 resolve galpão + busca pedido no Tiny (camada fiscal); IGNORA não-marketplace
  → processWebhookWms              ⬅ AQUI o processamento real acontece
       · resolverItensWms          Tiny produto_id → uuid WMS via siso_produto_empresas; expande kits
       · rotearPedidoDoBanco       lê siso_estoque → propria | transferencia | oc (geo-priority)
       · upsert siso_pedidos/itens · cria reservas R (TTL 30d) p/ propria+transferencia (OC não reserva)
       · propria → AUTO-APROVA (executando, aguardando_nf, enfileira lancar_estoque)
       · oc → AUTO-APROVA (executando, decisao_final='oc'; worker seta status_separacao='validacao_oc')
       · transferencia → pendente (painel humano)
  ──────────────────────────────────────────────────────────────
Aprovação humana (api/wms/pedidos/aprovar)   [transferencia; "rejeitado" cancela]
  · cria reservas R se faltarem; 409 se estoque live não cobre → enfileira lancar_estoque
  ──────────────────────────────────────────────────────────────
execution-worker (siso_fila_execucao, backoff exponencial, claim atômico)
  · lancar_estoque: marcadores Tiny + gera NF; OC valida shortfall contra siso_estoque LIVE
  · lancar_estoque_pos_nf → executarEstoquePosNfWms (R→L+S, estoque_lancado, aguardando_nf→aguardando_separacao)
  ──────────────────────────────────────────────────────────────
NF webhook (nota_fiscal) → nf-webhook-handler   aguardando_nf → aguardando_separacao; isDevolucao → siso_devolucoes_pendentes
  ──────────────────────────────────────────────────────────────
Entrada de estoque (mov tipo E) → reconciliador-oc.ts (fire-and-forget via ledger.ts)
  · por (produto, galpão), busca pedidos OC parados (aguardando_compra/validacao_oc)
  · FIFO por criado_em: para cada que o saldo livre cobre → reserva atômica + OC desvinculada
  · transiciona de volta a propria (decisao_final=propria, aguardando_nf, enfileira lancar_estoque)
  · receber via /api/wms/receber/oc/[id] (receberItensViaOC) agora seta recebido + chama release
  ──────────────────────────────────────────────────────────────
Separação: iniciar → em_separacao → marcar-item (L+S atômico no pick) → concluir → separado
           → confirmar-item-embalagem → embalado → [conferência opcional: embalador bipa etiqueta
           (embalado_real_por, status não muda) → conferente bipa → conferido] → expedir → expedido
           (parcial = 2 movs + re-busca cascade; encaminhar = manda pra outro galpão)
```

**`webhook-processor.ts` e `execution-worker.ts` são shells finos** — sempre delegam pros `-wms`. **Não existe mais flag `WMS_AS_SOURCE` / `flags.ts`**: o caminho WMS-as-source é permanente. A lógica legada de tier/multi-empresa nos arquivos base está dormante.

---

## Domínio: Empresa / Galpão / Grupo

- **Galpão** — local físico (CWB, SP). Independente de empresa.
- **Empresa** — conta Tiny com CNPJ próprio (NetAir, NetParts, 141AIR, EasyPeasy, Bellator). **NÃO pertence a um galpão** — opera em todos. "Casa" é só **preferência** via `siso_empresa_galpoes_preferenciais` (0..N, geo-priority=0 no roteamento).
- **Grupo** — afinidade de negócio (Autopecas) com tier. **Não dirige mais roteamento/dedução** (pós-3D, estoque é fungível por `(produto, galpão, loc)`). `grupo-resolver.ts` sobrevive só como lookup pra CRUD admin / display.

### Decisão (por pedido, em `wms/roteamento.ts`)

Conjunto: `propria | transferencia | oc` (sem empréstimo/swap no 3D).

1. Por galpão, tenta cobrir **todo** item a 100% de `siso_estoque` (fungível, exclui locks, prefere `tipo='picking'`).
2. Mantém os que cobrem 100%, ordena por `geoPriority` (0=casa/sem-preferência · 1=mesma cidade+UF · 2=mesma UF · 3=outro).
3. `geoPriority===0` → **propria** · cobre 100% mas não-casa → **transferencia** · ninguém cobre 100% mas há parcial → **oc** (`split_galpoes`) · ninguém tem nada → **oc** (`sem_cobertura`).

**Auto-aprovação:** `propria` e `oc`. Só `transferencia` vai pro painel.

### Status

- **Pedido** (`StatusPedido`): `pendente · executando · concluido · cancelado · erro`. `decisao_final`: `propria | transferencia | oc | rejeitado`.
- **Separação** (`StatusSeparacao`): `aguardando_compra → aguardando_nf → validacao_oc → aguardando_separacao → em_separacao → separado → embalado → conferido` (+ `pendente_realocacao`). `expedido` é escrito na coluna mas não está no type. Ordem canônica de `voltar-etapa`: `aguardando_nf → validacao_oc → aguardando_separacao → em_separacao → pendente_realocacao → separado → embalado → conferido`. **Conferência de embalagem (2026-06-11):** bip da etiqueta de envio em `/wms/separacao/conferencia` — modo embalar grava `embalado_real_por` (status não muda); modo conferir move `embalado→conferido` (visual, zero-clique, auto-conferência permitida); divergência (4 tipos) conta contra o embalador; expedir NÃO exige conferido. Barcodes da etiqueta em `siso_pedidos.etiqueta_barcodes` (ZPL + codigoRastreio Tiny; Shopee é raster — só rastreio). Métricas em `/wms/relatorios/conferencia`.

---

## Ledger de Estoque (3D)

Fonte única de estoque. Cada posição é única por **`(produto_id, galpao_id, localizacao_id)`**. Empresa **não é coordenada física** — viaja como **TAG** em movs com NF.

- **`siso_movimentacoes`** — ledger **imutável** (CORE). `tipo ∈ E/S/R/L` + `saldo/reservado anterior/posterior` (CHECKs de coerência) + `origem_tipo` (CHECK enumera ~18 valores) + tags nullable (`empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`, `fornecedor_id`, `custo_unitario`, `custo_medio_anterior/posterior`, `motivo`, `cliente_nome`) + `pedido_id` (text), `nota_fiscal_id` (uuid FK), `estorno_de`.
- **`siso_estoque`** — cache materializado. `saldo`, `reservado`, `disponivel` (GENERATED `saldo - reservado`), `UNIQUE(produto, galpão, loc)`, `CHECK(reservado <= saldo)`.
- **`siso_custo_medio`** — custo médio **global por produto** (PK `produto_id`). Recalculado (ponderado) só em entradas `E` com `custo_unitario` de origem `nf_compra` / `devolucao_cliente_integra` / `lancamento_retroativo`.

**`wms_inserir_movimentacao(...)` é o ÚNICO caminho de escrita no ledger.** Lock pessimista (`SELECT FOR UPDATE`), valida saldo/reservado, insere mov, atualiza cache e custo médio — tudo atômico.

---

## Estrutura do Projeto

```
src/
  app/
    api/auth/{login,me}/route.ts        # ÚNICAS rotas fora de /api/wms (PIN login + sessão)
    api/wms/**/route.ts                 # 214 rotas — TODO o backend
    wms/**                              # 60 pages (+layout) — TODO o frontend, todas "use client"
    login/page.tsx · page.tsx           # login + redirect pra /wms
    globals.css                         # Tailwind v4 (@theme inline)
  components/
    providers.tsx                       # QueryClient + AuthProvider + Toaster + SW
    ui/                                 # genéricos (loading-spinner, error-banner usados; resto legado)
    wms/
      wms-shell.tsx                     # sidebar (8 grupos perm-gated) + CommandK (⌘K) + modal context
      home/quadro-tarefas.tsx           # home /wms: pipeline + kanban + exceções
      {separacao,cross,insights,inventario,vendas,configuracoes,home}/  # por feature
      recebimento/{receber-lote.tsx,receber-lote-types.ts,receber-lote-adapters.ts}  # UI rica compartilhada de recebimento (config-driven; TODOS os fluxos — OC/manual/transferência/avulso — renderizam a mesma página completa pré-preenchida; extras OC/manual viram ajuste_manual; transferência sem custo/extras; criação de compra em /wms/compras/nova)
      ui/{wms-ui.tsx,modals.tsx,avatar.tsx}   # PageHeader, StatusBadge, Modal, formatters...
  hooks/                                # 5 realtime hooks (postgres_changes + Presence → invalidate React Query)
  lib/
    webhook-processor(-wms).ts          # entry shell → -wms (ativo)
    execution-worker(-wms).ts           # entry shell → -wms (ativo)
    nf-webhook-handler.ts               # nota_fiscal → aguardando_separacao; upsertNotaFiscal()
    pedido-cancel-handler.ts            # cancelamento de pedido (compartilhado webhook + polling)
    tiny-polling.ts                     # polling fallback Tiny (pedidos aprovados/cancelados + NFs autorizadas, janela 7d, cron 10min)
    empresa-lookup.ts                   # CNPJ→empresa (cache 5min)
    grupo-resolver.ts                   # lookup de grupo (não roteia mais)
    compras-*.ts                        # release, equivalencia, embalagem, necessidade, utils
    cross/**                            # busca universal, OEM, fetch Tiny
    separacao/**                        # bridge Tiny↔WMS (wms-mapping, realocacao-resolver, ...)
    tiny-{api,oauth,stub,queue}.ts · rate-limiter.ts · sku-fornecedor.ts
    ml-{api,oauth,anuncios,stub}.ts
    printnode.ts · etiqueta-*.ts · zpl-produto.ts · agrupamento-service.ts
    session.ts · permissions.ts · roles-loader.ts · auth-context.tsx
    logger.ts · supabase-server.ts · config.ts · historico-service.ts · utils.ts
    wms/
      cutover.ts                        # BACKSTOP de lançamento de estoque (NÃO é feature-flag!)
      ledger.ts                         # inserirMovimentacao(), estornarMovimentacao(), venderKit()
      custo-medio.ts · estoque.ts · live-stock.ts · produtos.ts · localizacoes.ts · kits.ts
      roteamento.ts · sugestao-dinamica.ts · reservas.ts · reservas-picking.ts
      movimentacoes.ts · guarda.ts · putaway.ts · receber-oc.ts · transferencias.ts
      crossdock-{detector,trigger}.ts · contagem-inline.ts
      inventario.ts · inventario-reconciliacao.ts (pura) · inventario-recovery.ts
      vendas-{disponibilidade,cancelamento}.ts · mandar-compras.ts · varredura-validacao-oc.ts
      fornecedores.ts · compras-manuais.ts · sync-tiny.ts · snapshot-inicial.ts · galpoes-com-saldo.ts
      reconciliacao.ts · reconciliacao-tiny.ts · cobertura.ts
      devolucoes.ts · devolucao-detector.ts (puro) · dashboard-{geral,tarefas}.ts
      insights/{motor,queries,types}.ts
      separacao/{pick-mov,distribuir-qty-pega,reset-state,alocacao-contagem}.ts
      _archive/                         # código 4D morto — excluído do typecheck, NÃO ressuscitar
supabase/migrations/                    # 184 .sql — YYYYMMDD_description.sql (sufixo b/c p/ mesmo dia)
scripts/wms/cenarios/                   # runner E2E + cenários + auth matrix
docs/                                   # ground-truth gerada (ver abaixo)
erros-conhecidos.yaml                   # base de erros (grep antes, adicionar depois)
```

### API — grupos por domínio (214 rotas em `/api/wms`)

`separacao` (33) · `admin` (21) · `inventario` (16) · `cross` (14) · `compras` (14) · `insights` (12) · `guarda` (10) · `pedidos` (8) · `compras-manuais` (7) · `ml` (7) · `tiny` (7) · `produtos` (6) · `vendas` (6) · `transferencias` (5) · `receber` (5) · `localizacoes` (5) · `devolucoes` (4) · `relatorios` (4) · `fornecedores` (3) + singletons (`estoque`, `ledger`, `ajuste`, `replenishment`, `cobertura`, `reconciliacao*`, `impressoes`, `dashboard-*`, `webhook`, `worker`, `snapshot-inicial`, `saldo-recebimento-orfao`, `transferir-galpao`, `rotear`, `lancamento-retroativo`, `produto-fornecedores`).

### Database — tabelas principais

| Tabela | Propósito |
|---|---|
| `siso_pedidos` | Pedidos. `id` é **text** (Tiny). `sugestao`/`decisao_final`, `status`+`status_separacao`, `empresa_origem_id`, `separacao_galpao_id`, `separacao_tags[]`. |
| `siso_pedido_itens` | Itens. ⚠ `produto_id` = **tiny_produto_id**, não uuid WMS. `quantidade_pega`, `separacao_parcial`, `mov_saida_id`. |
| `siso_estoque` / `siso_movimentacoes` / `siso_custo_medio` | Ledger 3D (acima). |
| `siso_produtos` | Catálogo unificado. `sku UNIQUE`, `eh_kit`, fiscal. |
| `siso_produto_empresas` | N:N produto↔empresa com `tiny_produto_id`. **Bridge Tiny→WMS.** |
| `siso_localizacoes` | Locs por galpão. `UNIQUE(galpao_id, codigo)`, `tipo ∈ picking/overstock/recebimento/expedicao/quarentena/packing`. Auto-seed `DEFAULT-PICKING`/`QUARENTENA`/`RECEBIMENTO`. |
| `siso_galpoes` / `siso_empresas` / `siso_empresa_galpoes_preferenciais` | Hierarquia. ⚠ `siso_empresas.galpao_id` DEPRECADA. |
| `siso_usuarios` / `siso_roles` / `siso_role_permissoes` / `siso_usuario_roles` | RBAC dinâmico (roles = dado, não código). |
| `siso_fila_execucao` | Fila pós-aprovação. ⚠ CHECKs legados `filial_execucao IN ('CWB','SP')`. |
| `siso_notas_fiscais` | NF canônica. `chave_acesso UNIQUE`. Alvo do FK `siso_movimentacoes.nota_fiscal_id`. |
| `siso_inventario_{sessoes,operadores,localizacoes,contagens,divergencias}` | Inventário v2 (pull queue + claim hierárquico). |
| `siso_wms_pendencias_guarda` | Fila put-away. `qty_pendente` GENERATED. status `pendente→em_guarda→guardada\|cancelada\|encerrada_sem_saldo`. FASE 6: iniciar reserva o saldo (R `reserva_guarda`); `encerrada_sem_saldo` = pick consumiu antes da guarda. |
| `siso_transferencias_galpao` (+itens) | Transferência inter-galpão (2 pernas S→E). |
| `siso_devolucoes_pendentes` · `siso_fornecedores` (+`produto_fornecedores`) · `siso_impressoes_log` · `siso_localizacao_locks` | Devoluções / fornecedores / log de impressão / locks. |
| `siso_compras_manuais` (+itens) | Compra avulsa de fornecedor (sem pedido). Recebimento gera mov `E` reusando `origem_tipo='nf_compra'` + `origem_detalhes.origem='compra_manual'` (sem NF) **+ pendência de put-away** (estorna a `E` se a pendência falhar). Sem RLS. |

> **Dropadas (não referenciar):** `siso_pedido_item_estoques`, `siso_emprestimo_regras`, `siso_wms_mini_swap_config`, `siso_transferencias`(+itens), `siso_inventarios`(+itens).

### RPCs-chave

`wms_inserir_movimentacao` (único write do ledger; aceita `p_idempotency_key` no-op desde fase-5) · `wms_reservar_atomico` (wrapper `tipo='R'`) · `wms_pick_item_atomico` (L+S no pick; aceita `p_idempotency_key`, propagado só no ramo sem-reserva) · `wms_iniciar_guarda_atomico` / `wms_confirmar_guarda_atomico` / `wms_desfazer_guarda_atomico` / `wms_cancelar_pendencia_guarda_atomico` (ver FASE 6 abaixo) · `wms_replenishment_intra_galpao` (par S+E) · `wms_inventario_proxima_loc` (pull queue + claim) / `wms_inventario_sugerir` · `wms_detectar_divergencias_estoque` / `wms_rebuild_linha_estoque` · `wms_refresh_curva_abc` / `wms_refresh_cobertura` (MVs `siso_curva_abc`, `siso_cobertura_estoque`) · `wms_truncate_operacional` (test harness).

**Raio-X Fase 5 (atomicidade tudo-ou-nada, tudo idempotente):** `wms_aplicar_sessao_inventario` (aplica divergências aprovadas de uma sessão de inventário em bloco) · `wms_pick_parcial_atomico` (S + ajuste loc_zerou na mesma tx) · `wms_desmarcar_item_atomico` (estorna par S+L do pick; recria R clampada ao saldo livre, retorna `status_alerta`) · `wms_reverter_cutover_atomico` (estorna S do pedido + recria R + flipa `estoque_lancado=false`) · `wms_vender_baixa_direta_atomico` (baixa N S de venda manual; advisory lock por tripla) · `wms_cancelar_venda_atomico` (estorna S `venda_manual` + marca pedido cancelado) · `wms_aprovar_e_enfileirar` (transição de status + INSERT do job `lancar_estoque` na mesma tx; `p_marcadores` é `text[]`) · `wms_reconciliar_retroativo` (lock + idempotência + estorno parcial clampado ao disponível) · `wms_resolver_pedido_fantasma` (R viva de pedido forward → `saiu`: R→L+S · `cancelado`: R→L + pedido cancelado).

**FASE 6 — Guarda dinâmica (reserva forte + auto-encerrar):** o put-away agora reserva o saldo na loc de recebimento ao INICIAR, evitando que um pick consuma a peça antes da guarda.
- `wms_iniciar_guarda_atomico(p_pendencia_id, p_usuario_id, p_forcar)`: `FOR UPDATE` + claim (status→`em_guarda`, idempotente p/ mesmo operador; `p_forcar`=takeover preservando `qty_guardada`) + cria **reserva forte** = mov `R` `origem_tipo='reserva_guarda'` (TTL 7d) sobre o saldo LIVRE da loc de recebimento (`LEAST(qty_pendente, saldo-reservado)`; não cria R de 0; idempotente). Zera o `disponivel` → roteamento de um pedido novo do mesmo SKU decide OC em vez de separar do recebimento. Conflito de claim → `55006`, mapeado p/ `PENDENCIA_OUTRA_GUARDA` (409) no serviço.
- `wms_confirmar_guarda_atomico`: **(a) auto-encerrar** — quando o saldo FÍSICO da loc de recebimento é `0 AND qty_pendente>0` (um pick consumiu antes do put-away) → status terminal `encerrada_sem_saldo`, RETURN early, sem par S+E, saldo intacto. ⚠ O trigger é `saldo=0`, **NÃO `disponivel=0`** (a R da própria pendência ainda está viva nesse ponto — `disponivel=0` é o caso NORMAL). **(b)** libera `L` `origem_tipo='liberacao_guarda'` da fração `p_qty` **ANTES** da perna S do replenishment (senão o S violaria `CHECK reservado<=saldo`); parcial mantém o resto da R.
- `wms_desfazer_guarda_atomico`: quando a pendência regride pra `em_guarda`, re-reserva (R `reserva_guarda`) o saldo que volta pra loc de recebimento (só se já existia R; clampado ao livre).
- `wms_cancelar_pendencia_guarda_atomico`: libera a R remanescente antes de marcar `cancelada` (devolve o `disponivel`; saldo físico intacto).
- Novo status terminal de pendência: `encerrada_sem_saldo`. Invariante I5 trata como terminal SEM exigir `qty_pendente=0`.

---

## Convenções

- **TypeScript strict.** Types centrais em `src/types/index.ts`; types WMS em `src/lib/wms/types.ts`. **Sem barrel exports** — importar direto da fonte.
- **Idioma:** Português pra domínio (`pedido`, `galpao`, `separacao`); inglês pra termos técnicos e **todos** os nomes de arquivo/função.
- **DB no server:** só via `createServiceClient()` (`supabase-server.ts`, memoizado, service role). Cliente browser quase não acessa Supabase direto — fala com `/api/wms/*`.
- **Logging:** nunca `console.*`. Usar `logger.info/warn/error(source, msg, meta?)`. Erros reais via `logger.logError({...})` → escreve em `siso_logs` + `siso_erros` (stack, categoria, correlation id). Categorias: `validation | database | external_api | auth | config | business_logic | infrastructure | unknown`.
- **Respostas de erro:** preferir `wmsErrorResponse({...})` de `lib/wms/api-errors.ts` (mascara 5xx pra `internal_error`, revela só 4xx, desempacota `PostgrestError`). Rotas simples: `NextResponse.json({ error: "..." }, { status })`.
- **Webhook é fire-and-forget** (200 imediato, processa async). Histórico via `registrarEvento()` (fire-and-forget safe).

### Auth (PIN custom, sem Supabase Auth)

- Login: `POST /api/auth/login` `{ nome, pin }` (PIN comparado em plaintext). Cria `siso_sessoes`, retorna `sessionId`.
- Cliente manda `X-Session-Id` (+ `X-Galpao-Id` opcional) em todo request. `getSessionUser(req)` valida e carrega roles/permissões. **Cache in-memory 30s** por instância (edições de role/galpão propagam em ≤30s).
- `auth-context.tsx`: persiste `siso_user` no localStorage; `sisoFetch` injeta os headers; 401 não-login limpa storage e redireciona pra `/login`.

### Permissões (RBAC dinâmico)

- **38 códigos em 8 módulos** (`vendas, visibilidade, operacoes, inventario, insights, relatorios, cadastros, sistema`) no registry `src/lib/permissions.ts` (formato `"modulo.acao"`).
- Roles em `siso_roles`/`siso_role_permissoes` (editáveis em `/wms/configuracoes/roles`). 6 system roles: `admin, operador, operador_cwb, operador_sp, comprador, vendedor`.
- **Checagem:**
  - Backend registry: `userCan(session, ...)` (TODAS; lista vazia ⇒ true) · `userCanAny(session, ...)` (PELO MENOS uma; lista vazia ⇒ false).
  - Backend guards (`lib/wms/auth.ts`): `requireAuth` · `requireAdmin` (proxy = `userCan("sistema.usuarios")`) · `requireWarehouseAccess` (exclui comprador/vendedor) · `requireWarehouseAccessOrOwnVenda`.
  - Frontend: `usePermissoes()` → `{ can, canAny }`. Sidebar items têm `requires: PermissaoCodigo[]`.
- ⚠ Nunca gate em `cargo` — sempre `userCan`. `siso_usuarios.cargo/cargos[]` são espelho legado dos roles (trigger).

---

## Gotchas (NÃO TROPECE NISSO)

1. **`siso_pedido_itens.produto_id` é o `tiny_produto_id`, NÃO o uuid de `siso_produtos`** (JSDoc em `types/index.ts:225`). Pra resolver: JOIN `siso_produto_empresas` ON `tiny_produto_id` filtrando por `empresa_origem_id` do pedido. Renomear é high-risk.
2. **`siso_pedidos.id` é `text`** (id Tiny numérico). Por isso `siso_movimentacoes.origem_id`/`pedido_id` são **text** (uma migration anterior que os fez uuid quebrou todos os callers de `wms_reservar_atomico`).
3. **Não existe `WMS_AS_SOURCE`/`flags.ts`** — o caminho WMS é permanente; `webhook-processor`/`execution-worker` sempre delegam pros `-wms`. `WMS_AS_SOURCE` no `.env.example` está **stale**.
4. **`cutover.ts` NÃO é feature-flag** — é o backstop que flipa `estoque_lancado` quando o pedido atinge `separado/embalado/expedido` e reverte (estorno + recria R) no retrocesso. **NF não é mais pré-condição** (2026-05-28) — o S sai no pick, atômico.
5. **`inserirMovimentacao` emite apenas `logger.warn` (não lança erro) se faltar `nota_fiscal_id`** em movs de origem NF (relaxado em 2026-05-27 — `ledger.ts ~154`). Enforcement real fica nos webhook handlers (`nf-webhook-handler`, `webhook-processor`) onde a NF realmente existe. Ainda assim, chamar `upsertNotaFiscal()` antes garante observabilidade correta.
6. **`pickMovPicking` não é idempotente nem atômico** — guardar via `mov_saida_id` antes, ou usar a RPC `wms_pick_item_atomico` (caminho de `marcar-item`).
7. **`live-stock.ts` / `galpoes-com-saldo.ts` lêem `siso_estoque` (live).** `siso_pedido_item_estoques` foi **dropada** — não conflate com snapshot.
8. **Todas as chamadas Tiny devem rodar dentro de `runWithEmpresa(empresaId, …)`** (AsyncLocalStorage carrega o contexto pro rate-limit e pro stub).
9. **TTL de reserva é inconsistente por design:** `reservas.ts` default 48h, mas pick-cascade/aprovar/webhook usam 30 dias (`24*30`).
10. **`createServiceClient()` cai pra anon key** se `SUPABASE_SERVICE_ROLE_KEY` ausente — degrada pra RLS silenciosamente.
11. **Colunas legadas 2-galpão dropadas** (`estoque_cwb_*`/`estoque_sp_*`/`cwb_atende`/`sp_atende`). Mas `siso_fila_execucao` ainda tem CHECK `filial_execucao IN ('CWB','SP')`.
12. **Comentário stale em `lib/wms/types.ts`** chama o custo de `siso_produto_custo_medio` — a tabela real é `siso_custo_medio`. Confiar na migration, não no comentário.
13. **Shape de erro 401 inconsistente** pela API (`{error:"unauthorized"}` vs `{error:"sessao_invalida"}` vs `{erro:"..."}`) — não assumir uma chave única.
14. **Rotas Tiny/ML de conexão+OAuth não têm session check** (`tiny/connections`, `tiny/stock/ajustar`, `ml/anuncios` etc.) — gap conhecido. `webhook/tiny` é público por design (valida por CNPJ + dedup).

---

## Integrações

- **Tiny ERP v3** (`api tiny.json` na raiz pra contratos). Base `https://api.tiny.com.br/public-api/v3`. OAuth2 via Keycloak (token curto, auto-refresh 60s de buffer). Respostas **sem** wrapper `{data}`. Depósitos vêm do endpoint de estoque (não há `/depositos`). Rate-limit per-empresa (`tiny-queue` + `rate-limiter`). Tiny é só camada **fiscal/marketplace** (emite NF, propaga pra ML/Shopee) — não controla mais estoque.
- **Mercado Livre** (`ml-*.ts`). OAuth2; `refresh_token` single-use; access 6h.
- **PrintNode** multi-conta (`siso_printnode_contas`). `resolverImpressora` = override-do-usuário > default-do-galpão. Etiquetas de envio (ZPL/PDF) + de produto (`zpl-produto.ts`, 2-por-folha). Jobs logados em `siso_impressoes_log` (retry manual).

---

## Documentação (MANTER ATUALIZADA NO MESMO COMMIT)

`docs/` tem documentação ground-truth gerada do código (verificar contra a fonte ao usar):

| Doc | Quando consultar |
|---|---|
| `docs/api-reference-complete.md` | Antes de qualquer mudança de rota. **Atualizar ao mudar rota.** |
| `docs/database-schema.md` | Antes de migration / entender data model. **Atualizar ao mudar schema.** |
| `docs/architecture-and-flows.md` + `docs/fluxos-siso.md` | Fluxos de negócio / state machines. **Atualizar ao mudar fluxo.** |

- **`erros-conhecidos.yaml`** (raiz): toda correção de bug **deve** virar entrada (`id, date, source, category, message, cause, fix, files, tags`). **Grep antes de debugar, adicionar depois de corrigir.**
- Mudou `CLAUDE.md` (estrutura/convenção/arquitetura)? Manter consistente com os docs acima.
- Adicionou lib service nova? Atualizar a seção "Estrutura do Projeto" aqui.
