# Checklist Fase 0 — WMS

Estado consolidado dos 5 planos da Fase 0. Use pra confirmar que tudo está em
staging antes de dar "go" pro Plano 6 (cutover big bang).

## Schema (em staging `ehbxpbeijofxtsbezwxd`)

### Plano 1 (Foundation)
- [x] `siso_produtos`, `siso_produto_empresas`
- [x] `siso_localizacoes` (com QUARENTENA + DEFAULT-PICKING auto)
- [x] `siso_estoque` (com `disponivel` GENERATED)
- [x] `siso_movimentacoes` (CHECKs aritméticos + tipos E/S/R/L)
- [x] RPC `wms_inserir_movimentacao` (lock pessimista)
- [x] RPCs `wms_detectar_divergencias_estoque` + `wms_rebuild_linha_estoque`

### Plano 3 (Roteamento)
- [x] `siso_fornecedores`, `siso_produto_fornecedores`
- [x] `siso_emprestimo_regras` (com `limites_por_produto` jsonb)
- [x] `siso_localizacao_locks`
- [x] RPC `wms_reservar_atomico`
- [x] RPC `wms_saldos_devedores`

### Plano 4 (Inventário)
- [x] `siso_inventario_sessoes`, `_areas`, `_localizacoes`, `_contagens`, `_divergencias`
- [x] RPC `wms_inventario_pegar_localizacao` (anti-colisão)
- [x] RPCs `wms_metricas_operador` + `wms_metricas_localizacao`
- [x] Materialized view `siso_curva_abc`

### Plano 5 (Exceções+Dashboards)
- [x] `siso_devolucoes_pendentes`
- [x] Materialized view `siso_cobertura_estoque`
- [x] RPC `wms_refresh_cobertura`

## APIs `/api/wms/*`

### Plano 1
- [x] produtos (GET/POST + [id] GET/PATCH + sync POST)
- [x] localizacoes (GET/POST + [id] PATCH/DELETE)
- [x] estoque (GET com 4 perspectivas)
- [x] ledger (GET com filtros)
- [x] snapshot-inicial (POST admin only)
- [x] reconciliacao (GET worker secret)

### Plano 2
- [x] receber (POST + GET sugestão)
- [x] transferir-galpao, replenishment, ajuste (POST)
- [x] lancamento-retroativo (POST + GET) + [id]/reconciliar (POST)

### Plano 3
- [x] fornecedores CRUD (4 routes) + auto-cadastro
- [x] produto-fornecedores CRUD (2 routes)
- [x] emprestimo-regras CRUD + limites jsonb
- [x] emprestimos/saldos (GET)
- [x] rotear (POST debug)
- [x] reservas/cleanup (GET worker secret)

### Plano 4
- [x] inventario CRUD + iniciar/aprovar/aplicar (3)
- [x] contagens (POST), bloquear (POST/DELETE)
- [x] divergencias (GET/PATCH)
- [x] metricas (GET)
- [x] cleanup (GET worker secret)

### Plano 5
- [x] devolucoes (GET + [id]/classificar POST)
- [x] troca-sku (POST)
- [x] cobertura (GET + refresh worker secret)
- [x] dashboard-geral (GET)

## Telas `/wms/*`

### Visibilidade
- [x] / (home com 4 grupos)
- [x] /dashboard
- [x] /estoque
- [x] /ledger
- [x] /cobertura

### Operação
- [x] /receber
- [x] /transferir
- [x] /replenishment
- [x] /ajuste
- [x] /devolucoes + [id]
- [x] /troca-sku
- [x] /retroativos

### Inventário
- [x] /inventario + [id]
- [x] /inventario/[id]/contar (handheld)
- [x] /inventario/[id]/divergencias
- [x] /inventario/metricas

### Cadastros
- [x] /produtos
- [x] /localizacoes
- [x] /fornecedores
- [x] /emprestimos

## Crons (configurar antes do go-live)

- [ ] `reservas/cleanup` — a cada hora
- [ ] `reconciliacao` (Plano 1) — a cada hora
- [ ] `cobertura/refresh` — diário 03h
- [ ] `inventario/cleanup` — locks 10min, sessões 4h
- [ ] Refresh de `siso_curva_abc` — diário (decidir horário)

## Validação técnica em staging

- [x] `npm test` passa (28+ testes)
- [x] `npm run build` compila
- [x] Schema 4D + ledger imutável + RPC com lock validados via SQL E2E
- [x] Reservas atômicas validadas (saldo 40 → reservado 5 → disponível 35)
- [x] Anti-colisão de inventário rejeita segundo `pegar` na mesma loc
- [ ] Snapshot inicial Tiny dry-run sem erro (precisa de `.env.local` com tokens Tiny)
- [ ] Snapshot real aplicado
- [ ] 1 cycle count completo end-to-end (precisa operadores logados)
- [ ] 1 inventário multi-operador end-to-end
- [ ] 1 devolução classificada
- [ ] 1 troca SKU registrada
- [ ] Reconciliação contínua sem divergências
- [ ] Dashboard geral mostra dados consistentes

## Sai pra Plano 6 (cutover) quando

- [ ] Todos os checks acima ✅
- [ ] Time treinado nas novas telas
- [ ] Estoque saneado via inventário físico (Plano 4)
- [ ] Cron jobs configurados em prod (não em staging)
- [ ] Decisão "go" do user explícita
