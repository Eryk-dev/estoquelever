# Ledger Simplificado — Estoque 3D sem camada de propriedade contábil

**Data:** 2026-05-20
**Status:** design aprovado em brainstorm, aguardando plano de implementação
**Substitui:** modelo 4D atual (produto, dona, galpão, loc) + empréstimo + swap + mini-swap
**Arquivado relacionado:** `docs/superpowers/archive/2026-05-20-empresa-dona-camada-contabil-design-dormente.html`

---

## 1. Contexto e motivação

O WMS atual modela estoque em quatro coordenadas físicas: **(produto, empresa dona, galpão, localização)**. Cada empresa do grupo (NetAir, NetParts, 141AIR, EasyPeasy, Bellator) tem saldo próprio em cada prateleira, com regras de empréstimo direcionais entre elas, swap inter-galpão e mini-swap pré-onda pra consolidar saldo da empresa picadora.

Esse modelo se rompe na operação física. As peças são fisicamente idênticas. Operador não tem como olhar pra uma cesta com 13 pastilhas EW123 e dizer quais são da NetAir e quais são da 141AIR. Isso gera:

- **Divergências fictícias de inventário:** operadora conta o total (correto), mas o sistema espera contagem por dona — não bate.
- **Escolha arbitrária na venda manual:** vendedor é forçado a escolher dona da peça que vai pegar, sem critério real.
- **Reservas amarradas a coordenada irreal:** roteamento decide trocar dona via swap/empréstimo pra "fazer caber", mas a peça física é sempre a mesma.
- **Complexidade alta com benefício baixo:** swap + mini-swap + matriz N×N existem só pra "consertar" a dor que o próprio modelo 4D criou.

Tentativa intermediária explorada no brainstorm: separar em duas camadas (físico 3D operacional + contábil 3D paralelo, atualizado automaticamente). Decisão final: **dropar a camada contábil também.** O custo de manter saldo+custo médio por empresa não compensa pra esse domínio. Apuração por empresa, quando necessária, vira **report sobre o ledger**, não estado mantido.

## 2. Decisões fundamentais

| # | Decisão |
|---|---|
| D1 | Schema operacional: 3D **(produto, galpão, localização)**. Empresa dona some do físico. |
| D2 | Ledger único, imutável, com **metadata rica** em cada linha: empresa-tag carregada apenas em movs com NF (entrada compra, saída venda, devolução). |
| D3 | Custo médio **global por produto** (uma média por SKU, agregando todos os galpões). |
| D4 | Apuração por empresa = **report ad-hoc** sobre o ledger. Sem estado mantido. |
| D5 | Empréstimo, swap, mini-swap, matriz N×N de regras: **arquivados**. Saem do código operacional. |
| D6 | Lógica do modelo abandonado: **preservada como design dormente** em `docs/superpowers/archive/` pra ressuscitação futura. |
| D7 | Migração: **big-bang em staging**. Zero dado real fora de produtos e localizações — saldo+ledger é tudo teste. |

## 3. Modelo de dados

### 3.1. `siso_estoque` — cache físico 3D

```
UNIQUE (produto_id, galpao_id, localizacao_id)
- saldo numeric
- reservado numeric (CHECK reservado <= saldo)
- disponivel numeric GENERATED ALWAYS AS (saldo - reservado) STORED
- atualizado_em timestamptz
```

**Mudanças vs. hoje:**
- DROP `empresa_dona_id`
- DROP `custo_medio` (sai daqui)
- UNIQUE muda de 4 colunas pra 3

### 3.2. `siso_movimentacoes` — ledger 3D com metadata rica

```
PK id uuid
- produto_id, galpao_id, localizacao_id (3D)
- tipo char(1) IN ('E','S','R','L')
- quantidade numeric (sempre positiva)
- saldo_anterior, saldo_posterior numeric
- reservado_anterior, reservado_posterior numeric
- origem_tipo text (lista enumerada — ver §3.4)
- origem_id uuid (correlaciona par S+E ou agrupa evento)
- origem_detalhes jsonb (campo livre — pequenas marcações)
- usuario_id uuid
- criado_em timestamptz default now()
- expira_em timestamptz (obrigatório SE tipo='R', proibido nos demais)
- estorno_de uuid REFERENCES siso_movimentacoes(id) (se mov é estorno)

NOVOS CAMPOS (todos nullable — preenchidos só onde fizer sentido):
- empresa_compradora_id uuid REFERENCES siso_empresas(id)   -- entradas via NF compra
- empresa_vendedora_id uuid REFERENCES siso_empresas(id)    -- saídas via NF venda
- empresa_referencia_id uuid REFERENCES siso_empresas(id)   -- devoluções referenciam NF original
- fornecedor_id uuid REFERENCES siso_fornecedores(id)       -- entradas/RMA
- pedido_id uuid REFERENCES siso_pedidos(id)                -- saídas + reservas
- nota_fiscal_id uuid                                       -- amarração fiscal
- chave_acesso_nf text
- cliente_nome text                                         -- saídas pra cliente
- motivo text                                               -- ajustes manuais
- custo_unitario numeric                                    -- entradas com custo definido
- custo_medio_anterior, custo_medio_posterior numeric       -- snapshots auditáveis

CONSTRAINTS:
- CHECK (tipo = 'R') = (expira_em IS NOT NULL)
- CHECK aritmética: saldo_posterior = saldo_anterior ± quantidade
- CHECK aritmética: reservado_posterior = reservado_anterior ± quantidade (quando R/L)
- CHECK origem_tipo IN (lista da §3.4)
```

**Mudanças vs. hoje:**
- DROP `empresa_dona_id`, `emprestimo_devedora_id`
- ADD 11 colunas nullable acima

### 3.3. `siso_custo_medio` — cache de custo global por produto (NOVA)

```
PK produto_id uuid REFERENCES siso_produtos(id)
- custo_medio numeric NOT NULL DEFAULT 0
- ultima_movimentacao_id uuid REFERENCES siso_movimentacoes(id)
- atualizado_em timestamptz default now()
```

Uma linha por produto. Atualizado atomicamente pela RPC `wms_inserir_movimentacao` quando entra mov com `custo_unitario IS NOT NULL` e `origem_tipo` que dispara recálculo (§4).

### 3.4. Lista de `origem_tipo` válidos

```
-- Entradas com tag de empresa
'nf_compra'                       -- recebimento NF de compra
'devolucao_cliente_integra'       -- devolução cliente íntegra (peça volta vendável)
'devolucao_cliente_avariada'      -- devolução cliente avariada (vai pra quarentena)
'devolucao_fornecedor_recebida'   -- RMA volta do fornecedor

-- Saídas com tag de empresa
'nf_venda'                        -- saída venda (marketplace ou manual)
'venda_manual'                    -- saída manual (Vendas Diretas modo baixa_direta)
'devolucao_fornecedor_enviada'    -- envio pra fornecedor (RMA garantia)

-- Operações neutras (sem empresa-tag)
'ajuste_manual'                   -- ajuste com motivo texto
'ajuste_pick_zerou'               -- gerado quando operador reporta loc zerada na separação
'inventario_perda'                -- divergência negativa aprovada
'inventario_ganho'                -- divergência positiva aprovada
'inventario_inicial'              -- snapshot inicial (uso histórico se reusar)
'transferencia_galpao'            -- par S+E entre galpões
'transferencia_localizacao'       -- par S+E entre locs (put-away, replenishment)
'reserva_pedido'                  -- R criada por roteamento
'liberacao_reserva'               -- L (NF emitida, cancelamento, expirado)
'lancamento_retroativo'           -- E pendente reconciliação NF futura
'estorno'                         -- estorno_de aponta pra mov original
```

**Removidos da lista atual:** `emprestimo`, `swap`, `troca_sku_in`, `troca_sku_out`, `cancelamento_nf`, `ajuste_loc_zerou` (renomeado pra `ajuste_pick_zerou` pra clareza).

### 3.5. Tabelas DROPADAS

- `siso_emprestimo_regras`
- `siso_wms_mini_swap_config`

### 3.6. RPCs dropadas / reescritas

**Dropadas:**
- `wms_executar_mini_swap`
- `wms_executar_swap`
- `wms_saldos_devedores`

**Reescritas (assinatura nova):**
- `wms_inserir_movimentacao(...)` — sem `empresa_dona`, com novos params nullable (empresa_compradora, empresa_vendedora, etc.) + custo_unitario. Atomicamente atualiza `siso_estoque` E `siso_custo_medio`.
- `wms_detectar_divergencias_estoque()` — drop comparação por empresa
- `wms_rebuild_linha_estoque(id)` — drop empresa_dona
- `wms_reservar_atomico(...)` — drop empresa_dona, sem trava por dona
- `wms_inventario_proxima_loc(p_sessao, p_user)` — drop filtro por empresa
- `wms_inventario_sugerir(p_galpao, p_tamanho)` — drop param empresa_dona (era opcional)

## 4. Custo médio — fórmula e gatilhos

### 4.1. Quem dispara recálculo

Apenas movs onde:
- `tipo = 'E'`
- `custo_unitario IS NOT NULL`
- `origem_tipo IN ('nf_compra', 'devolucao_cliente_integra')` — só essas dois dispararam recálculo. Outras entradas (ganho inventário, transferência chegando) não trazem novo custo.

### 4.2. Fórmula

```
saldo_global_atual = SUM(saldo) sobre TODAS locs+galpões do produto, antes da entrada
custo_atual = siso_custo_medio.custo_medio (ou 0 se nunca houve entrada)

SE saldo_global_atual + quantidade > 0:
  custo_novo = (saldo_global_atual × custo_atual + quantidade × custo_unitario)
               ─────────────────────────────────────────────────────────────────
                              saldo_global_atual + quantidade
SENÃO:
  custo_novo = custo_unitario (edge: primeira entrada absoluta)
```

### 4.3. Saídas + ajustes não mexem em custo médio

Operações que tiram saldo (venda, transferência saindo, perda inventário, ajuste manual negativo) **mantêm** o custo médio inalterado. O custo médio só varia quando entra novo lote com preço.

### 4.4. Edge: saldo global zera e depois entra de novo

- `saldo_global_atual = 0`
- `custo_novo = custo_unitario` (mesma fórmula da primeira entrada — denominador é só `quantidade`)
- Limpa histórico de custo do "ciclo" anterior

### 4.5. Estorno

Estornar uma entrada com custo:
- Reverte `siso_custo_medio.custo_medio` pro `custo_medio_anterior` registrado na mov original (snapshot)
- Atualiza `ultima_movimentacao_id` pro id do estorno

### 4.6. Snapshots no ledger

Toda mov (mesmo as que não recalculam) registra `custo_medio_anterior` e `custo_medio_posterior` — permite reconstruir o custo médio em qualquer instante do tempo a partir do ledger.

### 4.7. Atomicidade

A RPC `wms_inserir_movimentacao` faz tudo dentro de uma transação com locks pessimistas:

1. `SELECT FOR UPDATE` em `siso_estoque` da posição (produto, galpão, loc)
2. SE `tipo='E'` E `custo_unitario IS NOT NULL` E `origem_tipo` dispara recálculo:
   - `SELECT SUM(saldo) FROM siso_estoque WHERE produto_id = X` (snapshot do global)
   - `SELECT FOR UPDATE` em `siso_custo_medio` pra (produto)
   - Calcula `custo_novo`
3. Insere linha em `siso_movimentacoes` com saldos e custos anterior/posterior
4. UPDATE `siso_estoque` (saldo, reservado, atualizado_em)
5. SE recalculou custo: UPSERT em `siso_custo_medio`
6. COMMIT

## 5. Catálogo de operações

### 5.1. Operações com tag de empresa

| Operação | Tipo | Tags carregadas | Recalcula custo? |
|---|---|---|---|
| Recebimento via NF compra | E | empresa_compradora, fornecedor, nota_fiscal, chave_acesso_nf, custo_unitario | **Sim** |
| Venda marketplace (NF emitida pelo execution-worker) | S | empresa_vendedora, pedido_id, cliente_nome, nota_fiscal | Não |
| Venda manual (Vendas Diretas modo baixa_direta) | S | empresa_vendedora, pedido_id, cliente_nome | Não |
| Devolução cliente íntegra | E | empresa_referencia (= vendedora da NF original), pedido_id, custo_unitario (do custo médio atual ou da NF original) | **Sim, se custo_unitario informado** |
| Devolução cliente avariada | E + par S→E pra QUARENTENA | empresa_referencia, pedido_id | Não |
| Devolução pra fornecedor (RMA enviada) | S | empresa_referencia (= compradora da NF original), fornecedor | Não |
| Devolução fornecedor (RMA peça volta) | E | empresa_referencia (= compradora original), fornecedor | Não (retorna saldo, não muda custo médio) |

### 5.2. Operações neutras (sem empresa-tag)

| Operação | Tipo | Carrega | Recalcula custo? |
|---|---|---|---|
| Ajuste manual (operador) | E ou S | motivo, usuario_id | Não |
| Ajuste pick zerou (gerado na separação) | S | pedido_id, motivo='loc zerou no bipe' | Não |
| Perda de inventário aprovada | S | origem_id = sessao_inventario_id | Não |
| Ganho de inventário aprovado | E | origem_id = sessao_inventario_id | Não (entra sem custo) |
| Transferência inter-galpão | par S+E | origem_id compartilhado | Não |
| Replenishment intra-galpão | par S+E | origem_id compartilhado | Não |
| Put-away RECEBIMENTO → loc final | par S+E | origem_id compartilhado | Não |
| Reserva pedido | R | pedido_id, expira_em | Não |
| Liberação reserva (NF emitida, cancelamento, expirado) | L | estorno_de = R.id, motivo | Não |
| Lançamento retroativo | E | motivo, custo_unitario opcional | **Sim, se custo_unitario informado** |
| Estorno | inverso (E↔S, R↔L) | estorno_de = mov_original.id | **Sim, se estornando entrada que recalculou custo** |

### 5.3. Decisão de roteamento "propria/transferência/oc"

Hoje considera saldo por empresa do pedido. **Novo:**

- **propria** = pool físico no galpão origem tem saldo ≥ qty pedida
- **transferência** = pool físico em outro galpão tem saldo ≥ qty pedida
- **oc** = nenhum galpão cobre, abre ordem de compra

Sem distinção por empresa. Qualquer pedido com saldo no galpão origem é propria.

**Consequência:** alguns pedidos que hoje cairiam em "transferência" (porque a empresa do pedido não tinha saldo nominal) viram propria. Aceito como decisão consciente — pool é fungível.

## 6. Reports

### 6.1. Entradas/Saídas por SKU × empresa

**Query base:**
```sql
SELECT
  produto_id,
  CASE WHEN tipo='E' THEN empresa_compradora_id ELSE empresa_vendedora_id END AS empresa_id,
  tipo,
  SUM(quantidade) AS qty_total,
  SUM(quantidade * COALESCE(custo_unitario, 0)) AS valor_total
FROM siso_movimentacoes
WHERE criado_em BETWEEN $1 AND $2
  AND ($3 IS NULL OR galpao_id = $3)
  AND estorno_de IS NULL                          -- exclui estornos
GROUP BY produto_id, empresa_id, tipo
```

**UI:** `/wms/relatorios/movs-por-empresa` — filtros (período obrigatório, galpão opcional, empresa opcional, produto opcional) + tabela paginada + botão "Exportar CSV".

### 6.2. Histórico de custo médio

```sql
SELECT criado_em, custo_medio_anterior, custo_medio_posterior, custo_unitario, quantidade, origem_tipo
FROM siso_movimentacoes
WHERE produto_id = $1
  AND custo_medio_anterior IS NOT NULL  -- ou simplesmente WHERE tipo='E' AND custo_unitario IS NOT NULL
ORDER BY criado_em ASC
```

**UI:** `/wms/produtos/[id]/historico-custo` — linha temporal + gráfico.

### 6.3. Saldo virtual por empresa

Calcula Σ entradas − Σ saídas por empresa por (produto, galpão), apenas como visão analítica.

```sql
SELECT
  produto_id,
  galpao_id,
  empresa_compradora_id AS empresa_id,
  SUM(quantidade) FILTER (WHERE tipo='E') - SUM(quantidade) FILTER (WHERE tipo='S' AND empresa_vendedora_id = empresa_compradora_id) AS saldo_virtual
FROM siso_movimentacoes
WHERE estorno_de IS NULL
GROUP BY produto_id, galpao_id, empresa_id
```

(Refinamento de query é detalhe de implementação — a ideia é "quanto cada empresa comprou - quanto vendeu daquele SKU naquele galpão".)

**UI:** `/wms/relatorios/saldos-por-empresa` — read-only, sem efeito operacional. Útil pra contabilidade fechar mês.

### 6.4. Curva ABC / giro

Materialized view atual `siso_curva_abc` continua funcionando — ajusta queries pra dropar filtros por dona.

## 7. Migração

### 7.1. Pré-condição

Validado: zero dados reais em `siso_estoque`, `siso_movimentacoes`, `siso_pedido_item_estoques`. Produtos (`siso_produtos`), localizações (`siso_localizacoes`), empresas, galpões e fornecedores são reais e preservados.

### 7.2. Migration única — sequência

```sql
-- 1. Drop tabelas obsoletas
DROP TABLE IF EXISTS siso_emprestimo_regras CASCADE;
DROP TABLE IF EXISTS siso_wms_mini_swap_config CASCADE;

-- 2. Drop RPCs obsoletas
DROP FUNCTION IF EXISTS wms_executar_mini_swap(...);
DROP FUNCTION IF EXISTS wms_executar_swap(...);
DROP FUNCTION IF EXISTS wms_saldos_devedores();

-- 3. Limpar caches (sem dados reais)
TRUNCATE siso_movimentacoes CASCADE;
TRUNCATE siso_estoque CASCADE;
TRUNCATE siso_pedido_item_estoques CASCADE;
TRUNCATE siso_pedido_item_realocacoes CASCADE;

-- 4. Alterar siso_estoque pra 3D
ALTER TABLE siso_estoque DROP CONSTRAINT estoque_unique_4d;
ALTER TABLE siso_estoque DROP COLUMN empresa_dona_id;
ALTER TABLE siso_estoque DROP COLUMN custo_medio;
ALTER TABLE siso_estoque ADD CONSTRAINT estoque_unique_3d
  UNIQUE (produto_id, galpao_id, localizacao_id);

-- 5. Alterar siso_movimentacoes — drop colunas obsoletas
ALTER TABLE siso_movimentacoes DROP COLUMN empresa_dona_id;
ALTER TABLE siso_movimentacoes DROP COLUMN emprestimo_devedora_id;

-- 6. Alterar siso_movimentacoes — add metadata nova
ALTER TABLE siso_movimentacoes
  ADD COLUMN empresa_compradora_id uuid REFERENCES siso_empresas(id),
  ADD COLUMN empresa_vendedora_id uuid REFERENCES siso_empresas(id),
  ADD COLUMN empresa_referencia_id uuid REFERENCES siso_empresas(id),
  ADD COLUMN fornecedor_id uuid REFERENCES siso_fornecedores(id),
  ADD COLUMN motivo text,
  ADD COLUMN cliente_nome text,
  ADD COLUMN custo_unitario numeric,
  ADD COLUMN custo_medio_anterior numeric,
  ADD COLUMN custo_medio_posterior numeric;

-- 7. Atualizar CHECK constraint de origem_tipo (drop emprestimo, swap, etc.)
ALTER TABLE siso_movimentacoes DROP CONSTRAINT siso_movimentacoes_origem_tipo_check;
ALTER TABLE siso_movimentacoes ADD CONSTRAINT siso_movimentacoes_origem_tipo_check
  CHECK (origem_tipo IN (lista da §3.4));

-- 8. Cria siso_custo_medio
CREATE TABLE siso_custo_medio (
  produto_id uuid PRIMARY KEY REFERENCES siso_produtos(id) ON DELETE CASCADE,
  custo_medio numeric NOT NULL DEFAULT 0,
  ultima_movimentacao_id uuid REFERENCES siso_movimentacoes(id),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- 9. Reescrever wms_inserir_movimentacao com nova assinatura
CREATE OR REPLACE FUNCTION wms_inserir_movimentacao(...) ... ;

-- 10. Reescrever wms_detectar_divergencias_estoque + wms_rebuild_linha_estoque
CREATE OR REPLACE FUNCTION wms_detectar_divergencias_estoque() ... ;
CREATE OR REPLACE FUNCTION wms_rebuild_linha_estoque(p_id uuid) ... ;

-- 11. Reescrever wms_reservar_atomico (sem dona)
CREATE OR REPLACE FUNCTION wms_reservar_atomico(...) ... ;

-- 12. Reescrever RPCs de inventário (drop empresa_dona)
CREATE OR REPLACE FUNCTION wms_inventario_proxima_loc(...) ... ;
CREATE OR REPLACE FUNCTION wms_inventario_sugerir(...) ... ;

-- 13. Refresh views materializadas
REFRESH MATERIALIZED VIEW siso_curva_abc;
REFRESH MATERIALIZED VIEW siso_cobertura_estoque;
```

### 7.3. Realtime

A publication `supabase_realtime` continua incluindo `siso_estoque`, `siso_movimentacoes`, `siso_pedidos`, `siso_pedido_itens`, `siso_fila_execucao`, `siso_localizacao_locks`. Adicionar `siso_custo_medio` ao publication se UI quiser reagir a mudanças de custo.

## 8. Arquivamento

### 8.1. Documentação dormente

Mover pra `docs/superpowers/archive/`:

- `docs/superpowers/specs/2026-05-19-empresa-dona-camada-contabil-exemplos.html` → `docs/superpowers/archive/2026-05-20-empresa-dona-camada-contabil-design-dormente.html`
- `docs/superpowers/specs/2026-05-19-lancamentos-empresa-dona-emprestimos-swaps-fluxo.html` → `docs/superpowers/archive/2026-05-20-lancamentos-modelo-4d-fluxo.html`

Criar `docs/superpowers/archive/README.md` com:

```markdown
# Archive — designs dormentes

Esta pasta guarda designs que foram **completamente desenhados** mas **não implementados**, junto com a razão. Servem pra ressuscitação futura caso a regra de negócio mude.

## 2026-05-20 — empresa-dona-camada-contabil-design-dormente.html

Design completo de uma camada contábil 3D paralela (saldo + custo médio por empresa) com:
- Algoritmo de distribuição igual + cascade pra perdas
- Algoritmo proporcional inteiro (largest remainder) pra transferências
- Matriz N×N de empréstimo com limites por SKU
- Custo médio por empresa
- Reconciliação ledger ↔ cache em duas camadas

**Por que não foi implementado:** o custo de manter saldo e custo por empresa não compensa o ganho fiscal/contábil pra esse domínio. O operador físico não distingue donos de peças idênticas — qualquer escolha em movs operacionais (ajuste, transferência, inventário) é arbitrária. Apuração por empresa, quando necessária, sai de query no ledger (modelo simplificado em `specs/2026-05-20-ledger-simplificado-design.md`).
```

### 8.2. Código arquivado

Mover pra `src/lib/wms/_archive/`:

- `src/lib/wms/emprestimos.ts`
- `src/lib/wms/mini-swap.ts`
- `src/lib/wms/mini-swap-types.ts`
- `src/lib/wms/swap.ts` (se existir)
- `src/lib/wms/swap-types.ts` (se existir)
- Testes correspondentes

Cada arquivo recebe header de archive:
```ts
// ARCHIVED 2026-05-20 — see docs/superpowers/archive/README.md
// This module is no longer imported anywhere. Kept as reference for the
// 4D ownership model in case it gets resurrected.
```

### 8.3. APIs e páginas removidas

**APIs deletadas:**
- `/api/wms/swap/detectar`
- `/api/wms/swap/executar`
- `/api/wms/mini-swap/config/*`
- `/api/wms/mini-swap/simular`
- `/api/wms/emprestimos/saldos`
- `/api/wms/emprestimo-regras/*`

**Páginas frontend deletadas:**
- `/wms/emprestimos`
- `/wms/configuracoes/otimizacoes` (toggle do mini-swap)

**Sidebar:** remover item "Empréstimos" do grupo de cadastros.

## 9. Impactos em consumidores

### 9.1. Webhook processor

`webhook-processor-wms.ts`:
- Drop reservar por dona — vira `wms_reservar_atomico(produto, galpão, loc, qty, pedido)` 3D
- Drop lógica de agregação de estoque por empresa
- "auto-aprovar propria" passa a usar pool físico do galpão origem

### 9.2. Execution worker

`execution-worker-wms.ts`:
- Drop `emprestimo_devedora_id` em todas as movs
- Drop ordem por tier de empresa
- Saída via `nf_venda` carrega só `empresa_vendedora_id` (= empresa origem do pedido) + `pedido_id`

### 9.3. Separação

- `marcar-item`: mov de saída com `empresa_vendedora_id` (do pedido) e `pedido_id`
- Realocação cascateável: sem mudança (já era por produto+galpão+loc)
- Parcial: mov de saída + mov de ajuste (`ajuste_pick_zerou`) — sem tag de empresa no ajuste

### 9.4. Vendas Diretas

- `vendas/criar` modo `separacao`: cria pedido normal (sem efeito imediato no ledger)
- `vendas/criar` modo `baixa_direta`: gera mov `venda_manual` com `empresa_vendedora_id` (do pedido) + `pedido_id`
- `resolverDisponibilidadeVenda`: drop ordem por empresa origem — vira ordem por tipo loc (picking > overstock) + maior saldo

### 9.5. Inventário

- `siso_inventario_sessoes`: drop coluna `empresa_dona_id` (era opcional, agora some)
- Reconciliação temporal: simplifica (sem agrupamento por dona — só por loc)
- Divergências computadas no nível do pool físico
- `wms_inventario_sugerir` muda assinatura (remove `p_empresa_dona`)

### 9.6. Devoluções

- Classificação A/B/C/D: simplifica
  - A (íntegra): E `devolucao_cliente_integra` na loc original + `empresa_referencia` da NF
  - B (avariada): E na loc + par S→E pra QUARENTENA
  - C (garantia/RMA): E na loc + S `devolucao_fornecedor_enviada`
  - D (troca SKU): par S+E com mesmo `origem_id`
- Custo médio em devolução íntegra: opcional — se vier `custo_unitario` na NF de devolução, recalcula; senão, mantém o atual

### 9.7. Recebimento + Put-away

- `/api/wms/receber`: mov E `nf_compra` na loc RECEBIMENTO (ou direto na loc destino se `entrada_direta=true`) com `empresa_compradora_id`, `fornecedor_id`, `custo_unitario`, `nota_fiscal_id`
- `/api/wms/guarda/[id]/confirmar`: par S+E `transferencia_localizacao` RECEBIMENTO → loc destino — **sem tag de empresa**

## 10. Validação (testes)

### 10.1. Unit tests

- Função pura de custo médio (5 cenários: primeira entrada, entrada normal, entrada após saldo zero, custo zero, estorno)
- Reconciliação saldo físico ↔ ledger (3D)
- Geração correta de origem_id em pares S+E

### 10.2. Integration tests

- Recebimento → put-away → separação → expedição (E2E sem tag de empresa em ajustes/transferências)
- Devolução íntegra com custo recalcula corretamente
- Devolução avariada vai pra QUARENTENA
- Estorno de entrada com custo reverte o custo médio
- Inventário com perda gera S `inventario_perda` sem tag de empresa
- Transferência inter-galpão gera par S+E neutro
- Venda manual (Vendas Diretas) carrega `empresa_vendedora` correta
- Roteamento: pedido auto-aprovado quando galpão origem tem pool ≥ qty

### 10.3. Reports

- Fixture de 30 movs em 3 empresas × 2 galpões × 5 SKUs
- Validar export CSV agrupado por SKU × empresa × tipo
- Validar histórico de custo médio reconstruído da fixture
- Validar saldo virtual por empresa = Σ entradas − Σ saídas

## 11. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| **Auto-aprovar propria perde nuance** (pool fungível faz pedido auto-aprovar quando antes seria transferência) | Documentar como decisão consciente. Monitorar % de auto-aprovação após migração — se subir muito sem reclamação operacional, OK. |
| **Apuração fiscal por empresa fica como exercício de relatório** | Validar com contador antes de migrar. Reports cobertos pela §6. |
| **Conhecimento de empréstimo/swap/mini-swap se perde** | HTML dormente + README explicativo em archive/. Comentários nos arquivos arquivados. |
| **Custo médio global mistura preço de fornecedores diferentes em galpões diferentes** | Aceito como decisão (escolha B do brainstorm). Se virar problema, dá pra granular pra (produto, galpão) no futuro. |
| **Migração quebra páginas/APIs que ainda fazem hardcode de empresa-dona** | Auditoria do código + grep `empresa_dona` antes da migration. Lista de arquivos no plano de implementação. |

## 12. Critérios de sucesso

- [ ] Schema 3D em prod sem coluna `empresa_dona_id` em estoque/movs
- [ ] `siso_custo_medio` populado e atualizando corretamente
- [ ] Reports operacionais (movs por SKU × empresa, histórico custo, saldo virtual)
- [ ] Inventário em staging não acusa divergência fictícia por dona
- [ ] Venda manual em staging não pede escolha de dona
- [ ] Arquivo dormente preservado em `docs/superpowers/archive/`
- [ ] Zero código ativo de empréstimo/swap/mini-swap no path operacional
- [ ] CLAUDE.md atualizado com nova arquitetura
- [ ] `docs/architecture-and-flows.md` + `docs/database-schema.md` + `docs/api-reference-complete.md` atualizados

## 13. Fora de escopo deste design

- **Cutover Plano 6** (webhook-processor + execution-worker): segue independente. O novo modelo facilita o cutover (menos coordenadas pra rastrear), mas não depende dele.
- **PRDs em aberto** (`tasks/prd-pedidos-tracking.md`, `prd-pick-oc-separacao.md`, `prd-segunda-venda.md`, `prd-validacao-oc-separacao.md`): seguem em paralelo, ajustam ao novo schema na implementação.
- **UI redesign**: não é foco. Sidebar perde 1 item (Empréstimos), telas operacionais simplificam onde mostravam dona.
- **Performance de reports**: queries no ledger podem ficar pesadas com volume — otimização (materialized views, índices) é detalhe de implementação.
