# WMS — Design do Sistema de Estoque Interno do SISO

**Data:** 2026-05-07
**Status:** Spec aprovado pós-revisão técnica de logística — pronto pra plano de implementação
**Substitui:** plano em `docs/wms/` (descartado em 2026-05-07)
**Histórico de revisões:**
- 2026-05-07 v1 — design inicial
- 2026-05-07 v2 — revisão técnica de logística aplicada: localização como 4ª dimensão, TTL em reservas, cycle count com lock por localização, troca SKU como movimentação formal, roteamento por galpão único (split = OC), dashboard de cobertura por giro
- 2026-05-07 v3 — módulo robusto de inventário: sessões coletivas, áreas com múltiplos operadores em paralelo, blind count, re-contagem, workflow de aprovação por tolerância, atualização em tempo real via Supabase Realtime, métricas de acuracidade
- 2026-05-07 v4 — auditoria fresh-eyes aplicada: cargo `supervisor_logistica`, putaway com sugestão automática, lançamento retroativo (cross-docking implícito), cadastro de fornecedores com lead time, sincronização do catálogo via Tiny (NCM/CEST/origem/imagem), dashboard geral de eventos críticos, recovery de sessão de inventário órfã, pontos pendentes formalizados (separação parcial, avaria fora de devolução, RMA outbound)

---

## 1. Resumo executivo

O SISO hoje delega controle de estoque ao Tiny ERP: a cada webhook de pedido, faz `getEstoque()` no Tiny pra cada item de cada empresa do grupo (~3000+ chamadas/dia). Sem ledger local, sem catálogo unificado, sem rastro de empréstimos inter-empresa, sem reservas atômicas. Tiny é fonte da verdade.

Esse spec define uma reescrita do controle de estoque pra dentro do SISO: **ledger imutável append-only** como fonte da verdade, com cache materializado de saldo, registro formal de empréstimos entre empresas, regras configuráveis de compartilhamento e roteamento de pedidos com prioridade geográfica. Tiny vira ferramenta fiscal (NF, marcadores, cadastros) e seu saldo deixa de importar pra contabilidade.

A migração é em **5 fases**, começando com módulo standalone que não toca o fluxo crítico atual.

## 2. Princípios fundamentais (decisões travadas com user)

1. **SISO mestre absoluto.** Toda movimentação de estoque nasce e vive no SISO. Tiny vira ferramenta fiscal.
2. **Estoque tem 4 marcações:** produto, dono fiscal (quem pagou), galpão físico (onde está), localização dentro do galpão (prateleira/posição). Mesma SKU pode ter N donos × N localizações com saldos independentes.
3. **Ledger imutável append-only** é a fonte da verdade. `siso_estoque` é cache materializado, reconstruível a partir do ledger.
4. **Empréstimos como tracker puro.** Quitam por fluxo reverso (NetParts deve à NetAir; quita quando NetAir vendeu usando estoque da NetParts).
5. **Sharing rules em matriz N×N direcional** (empresa credora → empresa devedora, configurável por par).
6. **Prioridade de roteamento geográfica:** próprio antes de empréstimo; depois galpão home da vendedora > mesma cidade > mesmo estado > qualquer.
7. **Roteamento por galpão único:** todos os itens do pedido têm que caber num único galpão (próprio ou via empréstimo dentro daquele galpão). Se cobertura exige >1 galpão → vai pra OC. Não há split shipment.
8. **Reservas atômicas com lock pessimista** pra prevenir oversell entre aprovação e NF.
9. **Reservas têm TTL de 48h.** Pedido aprovado que não vira NF em 48h = reserva expira automaticamente, com alerta pro operador investigar pedido órfão.
10. **Entradas de estoque manuais em v1.** Operador registra recebimento via tela. Auto-import via NF de entrada fica pra v2+.
11. **Devoluções classificadas pelo operador** na chegada (íntegra, avariada, troca de SKU, garantia).
12. **Cycle count contínuo com produção rodando** via lock por localização (não bloqueia o galpão inteiro).
13. **Inventário multi-operador em paralelo com realtime.** Inventário completo divide o galpão em áreas; N operadores contam simultaneamente em handhelds/tablets; saldo agregado e progresso atualizam em tempo real pra todos via Supabase Realtime.
14. **Blind count e workflow de aprovação por tolerância.** Operador pode contar sem ver saldo esperado (antifraude). Divergências dentro de tolerância configurável aplicam direto; fora disso exigem re-contagem por outro operador ou aprovação manual.
15. **Marketplace sync deferido pra v2.** Tiny saldo vai divergir; aceita.
16. **Migração com isolamento total na Fase 0** (módulo standalone). Sem impacto no fluxo crítico atual até que toda funcionalidade isolada seja validada.
17. **Snapshot inicial via Tiny pra Fase 0.** Inventário físico real só depois do sistema estar funcionando estável (não cimentar a divergência atual antes de saber se o sistema novo funciona).
18. **Putaway com sugestão automática.** Ao receber estoque, sistema sugere localização baseado em (a) última localização onde o SKU foi guardado, (b) localização de picking se vazia, ou (c) overstock mais próximo. Operador pode aceitar ou trocar. Validação alerta se escolher localização tipo `expedicao` ou `quarentena` pra putaway.
19. **Lançamento retroativo (cross-docking implícito).** Se operador na separação tenta bipar SKU com saldo zero ou insuficiente, sistema permite registrar entrada de emergência (`origem_tipo='lancamento_retroativo'`) e seguir com a saída. Posteriormente, recebimento formal lança a NF de entrada e reconcilia. Evita engessar operação quando mercadoria chegou mas ainda não foi formalmente recebida.
20. **Catálogo sincronizado com Tiny.** A cada operação que envolve um produto (webhook de pedido, refetch manual), sistema atualiza dados do catálogo local (descrição, NCM, CEST, origem fiscal, imagem). Cache sempre fresco, sem chamadas redundantes em runtime.
21. **Dashboard geral de eventos críticos.** Tela única que centraliza alertas: cobertura crítica, reservas expiradas, sessões de inventário ativas, divergências pendentes, locks > N min, lançamentos retroativos não reconciliados, empréstimos crescendo unilateralmente.
22. **Salvamento contínuo + recovery em sessões de inventário.** Toda contagem é INSERT atômico no DB (já vem dos princípios 3 e 8); estado da sessão persiste a cada UPDATE. Cron detecta sessões órfãs (`em_andamento` > 24h sem contagens nas últimas 4h) e alerta supervisor pra retomar ou abortar.
23. **Cargo `supervisor_logistica`.** Nova role específica pra ações sensíveis de WMS (programar inventário completo, aprovar divergências grandes, editar matriz de empréstimos). Em v1, qualquer cargo pode executar qualquer ação; em v1.x ou v2 aplicar restrições por cargo.

## 3. Schema completo

### 3.1 Catálogo unificado

```sql
CREATE TABLE siso_produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  descricao text NOT NULL,
  gtin text,
  imagem_url text,
  unidade text NOT NULL DEFAULT 'UN',
  -- Fiscal
  ncm text,
  cest text,                                   -- Código Especificador da Subst. Tributária
  origem_fiscal smallint CHECK (origem_fiscal BETWEEN 0 AND 8),  -- 0=nacional, 1-8=estrangeiro/etc
  -- Sync com Tiny
  sincronizado_em timestamptz,                 -- última atualização vinda do Tiny
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_produtos_sku ON siso_produtos(sku);
CREATE INDEX idx_produtos_gtin ON siso_produtos(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_produtos_ativo ON siso_produtos(ativo) WHERE ativo = true;
CREATE INDEX idx_produtos_sincronizado ON siso_produtos(sincronizado_em);
```

**Sincronização com Tiny:** ao processar webhook de pedido ou ao operador clicar "atualizar produto", o serviço de sync (`produto-fetcher.ts` já existente no módulo Cross) busca dados do Tiny e faz UPDATE no catálogo. Mantém cache sempre fresco; sem chamada Tiny em runtime de hot paths.

### 3.2 Mapeamento SKU ↔ Tiny por empresa

```sql
CREATE TABLE siso_produto_empresas (
  produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id) ON DELETE CASCADE,
  tiny_produto_id bigint NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  PRIMARY KEY (produto_id, empresa_id),
  UNIQUE(empresa_id, tiny_produto_id)
);

CREATE INDEX idx_prod_emp_tiny ON siso_produto_empresas(empresa_id, tiny_produto_id);
```

### 3.3 Galpões (extensão do existente com geolocalização)

```sql
ALTER TABLE siso_galpoes
  ADD COLUMN cidade text,
  ADD COLUMN estado text CHECK (estado IS NULL OR estado ~ '^[A-Z]{2}$'),
  ADD COLUMN pais text NOT NULL DEFAULT 'BR';
```

### 3.4 Localizações dentro do galpão

```sql
CREATE TABLE siso_localizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  codigo text NOT NULL,           -- ex: "A-12-03" ou "RUA-3-PRAT-B"
  descricao text,                 -- ex: "Prateleira A, Fila 12, Posição 3"
  tipo text NOT NULL DEFAULT 'picking' CHECK (tipo IN (
    'picking',         -- localização ativa de separação
    'overstock',       -- excedente, fonte de replenishment
    'recebimento',     -- staging de mercadoria recém-chegada
    'expedicao',       -- staging pré-envio
    'quarentena'       -- avariado, aguardando descarte/RMA
  )),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(galpao_id, codigo)
);

CREATE INDEX idx_loc_galpao ON siso_localizacoes(galpao_id) WHERE ativo;
CREATE INDEX idx_loc_tipo ON siso_localizacoes(galpao_id, tipo) WHERE ativo;
```

**Convenção:** todo galpão tem ao menos uma localização default (ex: `DEFAULT-PICKING`) pra galpões sem endereçamento granular ainda. Operador pode evoluir o detalhamento ao longo do tempo.

### 3.5 Estoque (cache materializado da posição atual)

```sql
CREATE TABLE siso_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  saldo numeric NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  reservado numeric NOT NULL DEFAULT 0 CHECK (reservado >= 0),
  disponivel numeric GENERATED ALWAYS AS (saldo - reservado) STORED,
  custo_medio numeric(12,4) NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_id, empresa_dona_id, galpao_id, localizacao_id),
  CHECK (reservado <= saldo)
);

CREATE INDEX idx_estoque_dono ON siso_estoque(empresa_dona_id, produto_id);
CREATE INDEX idx_estoque_galpao ON siso_estoque(galpao_id, produto_id);
CREATE INDEX idx_estoque_loc ON siso_estoque(localizacao_id, produto_id);
CREATE INDEX idx_estoque_disponivel ON siso_estoque(produto_id) WHERE disponivel > 0;
```

**Constraint `reservado <= saldo`:** invariante que impede reservar mais do que tem.

**Quádrupla:** unidade mínima de estoque é `(produto, dona, galpão, localização)`. Mesma SKU pode aparecer em múltiplas linhas dentro do mesmo galpão (uma em picking, outra em overstock, por exemplo) — isso habilita rastreio de "está acabando na localização de picking" mesmo quando ainda tem no overstock.

### 3.6 Ledger de movimentações (CORE)

```sql
CREATE TABLE siso_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- O que se move (a quádrupla)
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),

  -- Tipo mecânico
  tipo char(1) NOT NULL CHECK (tipo IN ('E','S','R','L')),
  quantidade numeric NOT NULL CHECK (quantidade > 0),

  -- Chain verificável (saldo anterior/posterior + reservado anterior/posterior)
  saldo_anterior numeric NOT NULL CHECK (saldo_anterior >= 0),
  saldo_posterior numeric NOT NULL CHECK (saldo_posterior >= 0),
  reservado_anterior numeric NOT NULL CHECK (reservado_anterior >= 0),
  reservado_posterior numeric NOT NULL CHECK (reservado_posterior >= 0),

  -- Origem de negócio
  origem_tipo text NOT NULL CHECK (origem_tipo IN (
    'compra_manual',
    'lancamento_retroativo',          -- entrada de emergência (cross-docking implícito); aguarda reconciliação com compra_manual posterior
    'nf_venda',
    'nf_devolucao_cliente',
    'nf_devolucao_avariada',
    'nf_devolucao_fornecedor',
    'transferencia_galpao',           -- entre galpões da mesma empresa
    'transferencia_localizacao',      -- entre localizações do mesmo galpão (replenishment)
    'emprestimo',
    'reserva_pedido',
    'liberacao_reserva',
    'troca_sku_in',                   -- substituto entrando no pedido
    'troca_sku_out',                  -- SKU original saindo do pedido
    'ajuste_manual',
    'inventario',                     -- ajuste após cycle count ou contagem completa
    'inventario_inicial',
    'estorno',
    'cancelamento_nf'
  )),
  origem_id text,
  origem_detalhes jsonb NOT NULL DEFAULT '{}',

  -- Empréstimo (preenchido só quando origem_tipo='emprestimo')
  emprestimo_devedora_id uuid REFERENCES siso_empresas(id),

  -- Reserva: TTL (preenchido só quando tipo='R')
  expira_em timestamptz,

  -- Fiscal
  nota_fiscal_id bigint,
  chave_acesso_nf text,
  custo_unitario numeric(12,4),

  -- Audit
  usuario_id uuid REFERENCES siso_usuarios(id),
  observacoes text,
  estorno_de uuid REFERENCES siso_movimentacoes(id),

  criado_em timestamptz NOT NULL DEFAULT now(),

  -- Validações de consistência
  CHECK (
    (origem_tipo = 'emprestimo' AND emprestimo_devedora_id IS NOT NULL)
    OR (origem_tipo <> 'emprestimo' AND emprestimo_devedora_id IS NULL)
  ),
  CHECK (
    (tipo = 'R' AND expira_em IS NOT NULL)
    OR (tipo <> 'R' AND expira_em IS NULL)
  ),
  CHECK (
    (tipo = 'E' AND saldo_posterior = saldo_anterior + quantidade)
    OR (tipo = 'S' AND saldo_posterior = saldo_anterior - quantidade)
    OR (tipo IN ('R','L') AND saldo_posterior = saldo_anterior)
  ),
  CHECK (
    (tipo = 'R' AND reservado_posterior = reservado_anterior + quantidade)
    OR (tipo = 'L' AND reservado_posterior = reservado_anterior - quantidade)
    OR (tipo IN ('E','S') AND reservado_posterior = reservado_anterior)
  ),
  CHECK (reservado_posterior <= saldo_posterior)
);

CREATE INDEX idx_mov_produto ON siso_movimentacoes(produto_id, criado_em DESC);
CREATE INDEX idx_mov_dona ON siso_movimentacoes(empresa_dona_id, criado_em DESC);
CREATE INDEX idx_mov_galpao ON siso_movimentacoes(galpao_id, criado_em DESC);
CREATE INDEX idx_mov_loc ON siso_movimentacoes(localizacao_id, criado_em DESC);
CREATE INDEX idx_mov_origem ON siso_movimentacoes(origem_tipo, origem_id);
CREATE INDEX idx_mov_nf ON siso_movimentacoes(nota_fiscal_id) WHERE nota_fiscal_id IS NOT NULL;
CREATE INDEX idx_mov_estorno ON siso_movimentacoes(estorno_de) WHERE estorno_de IS NOT NULL;
CREATE INDEX idx_mov_emprestimo
  ON siso_movimentacoes(empresa_dona_id, emprestimo_devedora_id, criado_em DESC)
  WHERE origem_tipo = 'emprestimo';
CREATE INDEX idx_mov_reserva_expira
  ON siso_movimentacoes(expira_em)
  WHERE tipo = 'R' AND expira_em IS NOT NULL;
```

**Validações via CHECK:** garantem que `saldo_posterior` e `reservado_posterior` refletem corretamente o `tipo` e `quantidade`. Inclui também `reservado_posterior <= saldo_posterior` pra impossibilitar reservar mais do que cabe. Impossível inserir linha incoerente.

### 3.7 Regras de empréstimo (matriz N×N direcional)

```sql
CREATE TABLE siso_emprestimo_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_credora_id uuid NOT NULL REFERENCES siso_empresas(id),
  empresa_devedora_id uuid NOT NULL REFERENCES siso_empresas(id),
  ativo boolean NOT NULL DEFAULT true,
  limite_max_por_produto numeric,
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_credora_id, empresa_devedora_id),
  CHECK (empresa_credora_id <> empresa_devedora_id)
);

CREATE INDEX idx_regra_devedora ON siso_emprestimo_regras(empresa_devedora_id) WHERE ativo;
CREATE INDEX idx_regra_credora ON siso_emprestimo_regras(empresa_credora_id) WHERE ativo;
```

### 3.8 Fornecedores e lead time

Cadastro de fornecedores e relacionamento N:N com produtos, com lead time pra alimentar dashboard de cobertura e sugestões de OC.

```sql
CREATE TABLE siso_fornecedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  cnpj text UNIQUE,
  prefixo_sku text,                           -- ex: "19", "EW", "TG" (mapeamento existente em sku-fornecedor.ts)
  ativo boolean NOT NULL DEFAULT true,
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fornecedor_prefixo ON siso_fornecedores(prefixo_sku) WHERE ativo;
CREATE INDEX idx_fornecedor_cnpj ON siso_fornecedores(cnpj) WHERE cnpj IS NOT NULL;

CREATE TABLE siso_produto_fornecedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  fornecedor_id uuid NOT NULL REFERENCES siso_fornecedores(id) ON DELETE CASCADE,

  -- Lead time
  lead_time_dias_min int NOT NULL DEFAULT 7 CHECK (lead_time_dias_min >= 0),
  lead_time_dias_medio int NOT NULL DEFAULT 14 CHECK (lead_time_dias_medio >= 0),
  lead_time_dias_max int NOT NULL DEFAULT 30 CHECK (lead_time_dias_max >= 0),
  ultima_compra_em date,

  -- Comercial
  custo_unitario numeric(12,4),
  qty_minima_pedido numeric NOT NULL DEFAULT 1,
  multiplo_compra numeric NOT NULL DEFAULT 1,  -- ex: vende em caixa de 6 → multiplo=6
  preferencial boolean NOT NULL DEFAULT false, -- se true, é o fornecedor padrão

  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_id, fornecedor_id),
  CHECK (lead_time_dias_min <= lead_time_dias_medio),
  CHECK (lead_time_dias_medio <= lead_time_dias_max)
);

CREATE INDEX idx_pf_produto ON siso_produto_fornecedores(produto_id) WHERE ativo;
CREATE INDEX idx_pf_fornecedor ON siso_produto_fornecedores(fornecedor_id) WHERE ativo;
CREATE INDEX idx_pf_preferencial ON siso_produto_fornecedores(produto_id) WHERE preferencial AND ativo;
```

**Uso:** dashboard de cobertura (§8) cruza `dias_cobertura` com `lead_time_dias_medio` do fornecedor preferencial pra alertar quando reposição vai chegar tarde demais. Sugestão de OC usa `qty_minima_pedido` e `multiplo_compra` pra arredondar a quantidade sugerida.

### 3.9 Locks de localização (cycle count e contagens)

```sql
CREATE TABLE siso_localizacao_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  motivo text NOT NULL CHECK (motivo IN (
    'cycle_count',
    'contagem_completa',
    'manutencao'
  )),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  iniciado_por uuid NOT NULL REFERENCES siso_usuarios(id),
  finalizado_em timestamptz,
  observacoes text
);

CREATE UNIQUE INDEX uq_loc_lock_ativo
  ON siso_localizacao_locks(localizacao_id)
  WHERE finalizado_em IS NULL;

CREATE INDEX idx_loc_lock_ativos
  ON siso_localizacao_locks(iniciado_em)
  WHERE finalizado_em IS NULL;
```

**Semântica:** enquanto um lock está ativo (`finalizado_em IS NULL`), o roteamento ignora as linhas de `siso_estoque` daquela localização. Reservas pra essa localização falham com `LocalizacaoBloqueadaError`. Outras localizações operam normal.

### 3.10 Sessões de inventário

Sessão master que orquestra cycle count ou inventário completo. Suporta múltiplos operadores em paralelo, blind count, tolerância configurável e workflow de aprovação.

```sql
CREATE TABLE siso_inventario_sessoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tipo e escopo
  tipo text NOT NULL CHECK (tipo IN ('cycle_count', 'completo')),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  empresa_dona_id uuid REFERENCES siso_empresas(id),  -- NULL = todas as empresas do galpão

  -- Configurações de contagem
  modo_contagem text NOT NULL DEFAULT 'aberto' CHECK (modo_contagem IN (
    'aberto',        -- operador vê saldo esperado
    'blind',         -- operador conta sem ver saldo (antifraude)
    'duplo_blind'    -- 2 operadores contam blind, sistema compara
  )),
  tolerancia_pct numeric NOT NULL DEFAULT 0 CHECK (tolerancia_pct >= 0),
  tolerancia_qty_min numeric NOT NULL DEFAULT 0 CHECK (tolerancia_qty_min >= 0),
  exige_aprovacao_acima_valor numeric,  -- divergência financeira que exige aprovação dupla

  -- Status lifecycle
  status text NOT NULL DEFAULT 'planejada' CHECK (status IN (
    'planejada',      -- criada, escopo definido
    'em_andamento',   -- locks ativos, operadores contando
    'revisao',        -- todas localizações contadas, divergências em análise
    'aprovada',       -- admin validou ajustes
    'aplicada',       -- movs no ledger inseridas, locks liberados
    'cancelada'
  )),

  -- Timeline
  programada_para date,
  iniciada_em timestamptz,
  finalizada_em timestamptz,
  aplicada_em timestamptz,

  -- Audit
  criada_por uuid NOT NULL REFERENCES siso_usuarios(id),
  aprovada_por uuid REFERENCES siso_usuarios(id),
  observacoes text,

  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_sessoes_status ON siso_inventario_sessoes(status, galpao_id);
CREATE INDEX idx_inv_sessoes_galpao ON siso_inventario_sessoes(galpao_id, criado_em DESC);
CREATE INDEX idx_inv_sessoes_ativas ON siso_inventario_sessoes(galpao_id) WHERE status = 'em_andamento';
```

### 3.11 Áreas (divisão de operadores em paralelo)

Pra inventário completo: divide o galpão em N áreas, atribui operadores. Pra cycle count: tipicamente 1 área única.

```sql
CREATE TABLE siso_inventario_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  nome text NOT NULL,                          -- ex: "Área Norte", "Corredor A-B", "Cycle 2026-05-08"
  operador_id uuid REFERENCES siso_usuarios(id),  -- NULL = qualquer operador da sessão pode pegar
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente', 'em_andamento', 'concluida'
  )),
  iniciada_em timestamptz,
  finalizada_em timestamptz,
  UNIQUE(sessao_id, nome)
);

CREATE INDEX idx_inv_areas_sessao ON siso_inventario_areas(sessao_id, status);
CREATE INDEX idx_inv_areas_operador ON siso_inventario_areas(operador_id) WHERE status = 'em_andamento';
```

### 3.12 Localizações da sessão

Mapeia quais localizações pertencem a quais áreas, e o status de cada uma. Inclui anti-colisão (`bloqueada_por`).

```sql
CREATE TABLE siso_inventario_localizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  area_id uuid NOT NULL REFERENCES siso_inventario_areas(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),

  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente',          -- aguardando contagem
    'em_contagem',       -- operador X está contando agora
    'contada',           -- 1ª rodada concluída
    'divergente',        -- diferença detectada, em análise
    'recontagem',        -- 2ª rodada solicitada
    'aprovada'           -- divergência tratada, mov gerada
  )),

  -- Anti-colisão (lock otimista pra UI)
  bloqueada_por uuid REFERENCES siso_usuarios(id),
  bloqueada_em timestamptz,

  UNIQUE(sessao_id, localizacao_id)
);

CREATE INDEX idx_inv_loc_sessao ON siso_inventario_localizacoes(sessao_id, status);
CREATE INDEX idx_inv_loc_area ON siso_inventario_localizacoes(area_id, status);
CREATE INDEX idx_inv_loc_bloqueada
  ON siso_inventario_localizacoes(bloqueada_por, bloqueada_em)
  WHERE bloqueada_em IS NOT NULL;
```

### 3.13 Contagens individuais

Cada bipe/registro feito por um operador. Suporta múltiplas contagens da mesma quádrupla (blind count com 2 operadores, ou re-contagem em rodadas posteriores).

```sql
CREATE TABLE siso_inventario_contagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),

  qty_contada numeric NOT NULL CHECK (qty_contada >= 0),
  rodada smallint NOT NULL DEFAULT 1 CHECK (rodada >= 1),  -- 1 = primeira; 2+ = re-contagens

  contada_por uuid NOT NULL REFERENCES siso_usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_cont_sessao ON siso_inventario_contagens(sessao_id, criado_em DESC);
CREATE INDEX idx_inv_cont_loc ON siso_inventario_contagens(sessao_id, localizacao_id, rodada);
CREATE INDEX idx_inv_cont_operador ON siso_inventario_contagens(contada_por, criado_em DESC);
CREATE INDEX idx_inv_cont_quadrupla
  ON siso_inventario_contagens(sessao_id, localizacao_id, produto_id, empresa_dona_id, rodada);
```

### 3.14 Divergências e workflow de aprovação

Computadas automaticamente após contagem (ou após múltiplas rodadas se duplo_blind). Geram mov no ledger quando aplicadas.

```sql
CREATE TABLE siso_inventario_divergencias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id uuid NOT NULL REFERENCES siso_inventario_sessoes(id) ON DELETE CASCADE,
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),

  saldo_sistema numeric NOT NULL,        -- saldo no momento do snapshot
  qty_contada_final numeric NOT NULL,    -- qty consolidada (após eventual re-contagem)
  delta numeric GENERATED ALWAYS AS (qty_contada_final - saldo_sistema) STORED,
  delta_pct numeric GENERATED ALWAYS AS (
    CASE WHEN saldo_sistema = 0 THEN NULL
         ELSE ROUND((qty_contada_final - saldo_sistema) / saldo_sistema * 100, 4)
    END
  ) STORED,
  valor_financeiro numeric,              -- delta * custo_medio (impacto contábil)

  status text NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente',
    'recontagem_solicitada',
    'aprovada',
    'rejeitada',
    'aplicada'
  )),

  resolucao_por uuid REFERENCES siso_usuarios(id),
  resolucao_em timestamptz,
  observacoes_resolucao text,
  mov_aplicada_id uuid REFERENCES siso_movimentacoes(id),  -- id da mov gerada quando 'aplicada'

  UNIQUE(sessao_id, localizacao_id, produto_id, empresa_dona_id)
);

CREATE INDEX idx_inv_div_sessao ON siso_inventario_divergencias(sessao_id, status);
CREATE INDEX idx_inv_div_status ON siso_inventario_divergencias(status, sessao_id);
CREATE INDEX idx_inv_div_aprovacao ON siso_inventario_divergencias(sessao_id) WHERE status = 'pendente';
```

### 3.15 Diagrama ER

```
siso_produtos ──┬── siso_produto_empresas ── siso_empresas ──┬── siso_galpoes ── siso_localizacoes
                │                                              │                       │
                ├── siso_produto_fornecedores ── siso_fornecedores                     │
                │                                                                      │
                ├── siso_estoque ─────────────────────────────┼──────────────────────┤
                │                                              │                       │
                ├── siso_movimentacoes ───────────────────────┼──────────────────────┤
                │                                              │                       │
                └── (consultas derivadas: saldo devedor,       │                       │
                     dias de cobertura, acuracidade, etc)      │                       │
                                                                │                       │
siso_emprestimo_regras (credora_id, devedora_id) ──────────────┘                       │
                                                                                        │
siso_localizacao_locks (localizacao_id) ───────────────────────────────────────────────┤
                                                                                        │
siso_inventario_sessoes ─┬── siso_inventario_areas (operador_id) ──┐                   │
                          │                                          │                   │
                          ├── siso_inventario_localizacoes ──────────┴───────────────────┤
                          │                                                              │
                          ├── siso_inventario_contagens (contada_por, rodada) ───────────┤
                          │                                                              │
                          └── siso_inventario_divergencias (mov_aplicada_id → ledger) ──┘
```

## 4. Tipos de movimentação (origem_tipo)

| origem_tipo | Tipo | Disparado por | Observações |
|---|---|---|---|
| `inventario_inicial` | E | Job de migração | Snapshot fundacional na Fase 0 (puxa do Tiny) |
| `compra_manual` | E | Operador | Tela "Receber estoque", escolhe localização de putaway (com sugestão automática) |
| `lancamento_retroativo` | E | Operador na separação/etc | Mercadoria já chegou mas não foi formalmente recebida; sistema aceita pra não engessar; reconciliada com `compra_manual` posterior |
| `nf_venda` | S | Webhook NF venda | Vendedora = dona |
| `emprestimo` | S | Webhook NF venda | Vendedora ≠ dona; preenche `emprestimo_devedora_id` |
| `nf_devolucao_cliente` | E | Operador classifica | Volta pra dona original (quita empréstimo se aplicável) |
| `nf_devolucao_avariada` | E + S | Operador classifica | Par atômico: entra fiscalmente + sai por avaria pra quarentena |
| `nf_devolucao_fornecedor` | S | Operador | RMA pra fornecedor |
| `transferencia_galpao` | S + E | Operador | Par atômico entre galpões da mesma empresa |
| `transferencia_localizacao` | S + E | Operador | Par atômico entre localizações do mesmo galpão (replenishment) |
| `reserva_pedido` | R | Aprovação de pedido | Lock pessimista, com `expira_em = now() + 48h` |
| `liberacao_reserva` | L | NF emitida, cancelamento, troca SKU, expiração de TTL | Em par com S quando NF, ou solo quando outras causas |
| `troca_sku_in` | R | Operador na separação | Reserva substituto Y |
| `troca_sku_out` | L | Operador na separação | Libera reserva original X (par com `troca_sku_in`) |
| `ajuste_manual` | E ou S | Operador | Motivo obrigatório (avaria, perda, encontro, erro contagem) |
| `inventario` | E ou S | Cycle count ou sessão completa | Delta após contagem física |
| `estorno` | inverso | Admin | `estorno_de` aponta pra mov original |
| `cancelamento_nf` | inverso de S | Webhook cancelamento | Auto-disparado quando Tiny notifica cancelamento de NF |

## 5. Fluxos críticos

### 5.1 Entrada manual de estoque (compra recebida)

```
Operador recebe mercadoria fisicamente.
→ Abre tela "Receber estoque" no SISO.
→ Preenche: empresa dona, galpão de destino, item por item (SKU/qty/custo).
→ Pra cada item: escolhe localização de putaway (default: localização de recebimento do galpão).
→ Opcional: NF número e PDF anexo (referência fiscal).
→ Confirma.

Sistema, em transação atômica por item:
  - Resolve produto via SKU (cria no catálogo se novo).
  - Insere mov tipo='E' origem='compra_manual' na quádrupla escolhida.
  - UPDATE siso_estoque (produto, dona, galpão, localização): saldo += qty.
  - Recalcula custo_medio (média ponderada com saldo anterior daquela linha).
```

Nada toca o Tiny.

**Fluxo de putaway sugerido:** após receber em "RECEBIMENTO", operador faz transferência interna pra localização de picking ou overstock (fluxo 5.6).

### 5.2 Venda própria (vendedora = dona do estoque)

```
Webhook pedido → identifica empresa V vendedora.

Roteamento (resumo — detalhes em §6):
  - Pra cada item, busca galpão único onde V tem disponivel ≥ qty
  - Se múltiplos galpões cobrem, escolhe por geo (home > cidade > estado)
  - Dentro do galpão, escolhe localização (preferência: 'picking' antes de 'overstock')
  → Resultado: lista de quádruplas (uma por item)

Reserva atômica (loop pelos itens, em ordem determinística por produto_id):
  BEGIN;
    SELECT * FROM siso_estoque WHERE (quadrupla) FOR UPDATE;
    INSERT mov tipo='R' origem='reserva_pedido' expira_em=now()+48h;
    UPDATE siso_estoque SET reservado = reservado + qty;
  COMMIT;

Worker → Tiny: gera NF de venda na empresa V.

Webhook NF autorizada chega:
  BEGIN;
    INSERT mov tipo='S' origem='nf_venda', nota_fiscal_id;
    INSERT mov tipo='L' origem='liberacao_reserva';
    UPDATE siso_estoque SET saldo -= qty, reservado -= qty;
  COMMIT;
```

### 5.3 Venda com empréstimo (vendedora ≠ dona)

```
Webhook pedido → identifica empresa V vendedora.

Roteamento (V não tem próprio no galpão escolhido pra todos os itens):
  Algoritmo de §6 detecta que galpão único cobre, mas algum item exige empréstimo.
  Pedido vai pra painel humano (decisão 'emprestimo'); operador aprova.

Reserva atômica em (X, C, galpão, localização) — C = credora autorizada:
  - mov tipo='R' origem='reserva_pedido', expira_em=now()+48h

Worker → Tiny: gera NF de venda na empresa V (não em C).

Webhook NF autorizada:
  - mov tipo='S' origem='emprestimo' (na quádrupla X, C, galpão, localização)
    com emprestimo_devedora_id = V
  - mov tipo='L' origem='liberacao_reserva'
  - UPDATE siso_estoque: saldo -= qty, reservado -= qty
```

**Resultado:** V deve `qty` unidades a C. Saldo de C cai naquela localização. Saldo de V inalterado no SISO.

**Tiny:** NF emitida pela V; saldo Tiny da V vai pra negativo (ok, fictício). Saldo Tiny da C não muda (NF não é dela).

### 5.4 Devolução de cliente

Quando NF de devolução chega via webhook, **não é processada automaticamente**. Vai pra fila "Devoluções pendentes":

```
NF devolução webhook → INSERT siso_devolucoes_pendentes (status='aguardando_classificacao')
                       (NF vinculada, pedido original identificado, mercadoria ainda não chegou)
```

Quando mercadoria chega fisicamente, operador abre fila e classifica. Galpão de recebimento e localização são escolhidos pelo operador (default: localização de recebimento do galpão home).

#### 5.4.1 Classificação A — Íntegro

```
Sistema identifica: pedido original era "venda própria" ou "empréstimo".
- Se própria: dona da entrada = empresa vendedora.
- Se empréstimo: dona da entrada = empresa credora original (auto-quita 1 unidade do empréstimo).

INSERT mov tipo='E' origem='nf_devolucao_cliente'
  na quádrupla (produto, dona, galpão_de_recebimento, localizacao_de_recebimento)
UPDATE siso_estoque: saldo += qty
```

#### 5.4.2 Classificação B — Avariado

```
Mesma resolução de dona (A vai pra dona original, B vai pra credora original).

Em transação atômica:
  INSERT mov tipo='E' origem='nf_devolucao_avariada' (volta fiscalmente, no recebimento)
  INSERT mov tipo='S' origem='ajuste_manual' (sai pra quarentena, motivo='retorno_quebrado')
  Net efeito: linhas no ledger registram a avaria; mercadoria fica em localização tipo='quarentena' aguardando descarte ou RMA.
```

#### 5.4.3 Classificação C — Garantia

```
Mesma resolução de dona.

INSERT mov tipo='E' origem='nf_devolucao_cliente' (entra na quarentena)
INSERT mov tipo='S' origem='nf_devolucao_fornecedor' (sai pra fornecedor — RMA)
  observacoes = 'garantia, motivo: <descrito pelo operador>'

Auto-quita o empréstimo (se aplicável) na entrada, mas não cria estoque vendável.
```

#### 5.4.4 Classificação D — Troca de SKU pelo cliente

Cliente devolveu SKU-X e quer SKU-Y. Operador classifica devolução de X como íntegra (entra normal) e cria pedido novo pra Y, ou aplica troca direta:

```
Em transação atômica:
  INSERT mov tipo='E' origem='nf_devolucao_cliente' (X volta normal pra dona original)
  Se já tem pedido pendente trocando X→Y na separação: usa fluxo 5.8 (troca SKU).
```

### 5.5 Transferência inter-galpão (intra-empresa)

```
Operador abre "Transferir entre galpões" no SISO.
Escolhe empresa (NetAir), galpão+localização origem (CWB/A-12), galpão+localização destino (SP/B-03), itens, qty.
Confirma.

Em transação atômica:
  INSERT mov tipo='S' origem='transferencia_galpao' em (produto, NetAir, CWB, A-12)
  INSERT mov tipo='E' origem='transferencia_galpao' em (produto, NetAir, SP, B-03)
  Mesmo origem_id (sessão de transferência).
  UPDATE ambas linhas de siso_estoque.
```

Sem NF. Sem Tiny. Útil pra balanceamento entre galpões da mesma empresa.

### 5.6 Replenishment intra-galpão (entre localizações do mesmo galpão)

Caso de uso: localização de picking (A-12) está esvaziando; operador pega do overstock (Z-99) pra repor.

```
Operador abre "Replenishment" no SISO.
Escolhe empresa, galpão, localização origem (Z-99), localização destino (A-12), itens, qty.
Confirma.

Em transação atômica:
  INSERT mov tipo='S' origem='transferencia_localizacao' em (produto, dona, galpão, Z-99)
  INSERT mov tipo='E' origem='transferencia_localizacao' em (produto, dona, galpão, A-12)
  Mesmo origem_id.
  UPDATE ambas linhas.
```

**Trigger sugerido:** dashboard de avisos (§8) detecta quando localização de picking tem cobertura < N dias e alerta o operador pra fazer replenishment a partir do overstock.

### 5.7 Inventário (cycle count e completo)

Módulo robusto suportando dois modos: **cycle count** (rotativo, com produção rodando) e **inventário completo** (galpão inteiro, congelado, multi-operador). Ambos compartilham a mesma estrutura de sessão (§3.9-3.13), diferindo em escopo e impacto operacional.

#### 5.7.1 Estrutura comum

Toda sessão segue o ciclo:

```
[planejada] → [em_andamento] → [revisao] → [aprovada] → [aplicada]
                                       \─→ [cancelada] (a qualquer momento, por admin)
```

**Snapshot de saldo:** ao mudar pra `em_andamento`, sistema "fotografa" o saldo atual de cada quádrupla coberta na sessão (registra em memória/cache pra comparar com a contagem). É o ground truth a confrontar.

**Locks:** pra cada localização da sessão, INSERT em `siso_localizacao_locks` com motivo `cycle_count` ou `contagem_completa`. Roteamento ignora essas linhas; reservas falham com `LocalizacaoBloqueadaError`.

**Aplicação no ledger:** quando sessão vira `aprovada`, todas as divergências aprovadas geram movs `tipo='E'` ou `'S'` `origem='inventario'` no ledger, em transação atômica por divergência. `mov_aplicada_id` é gravado na divergência pra rastreio bidirecional.

#### 5.7.2 Cycle count (rotativo, com produção rodando)

Sessão pequena, geralmente 1 área única com 5-50 localizações, executada por 1-2 operadores. Resto do galpão opera normal.

**Fluxo:**

```
1. Admin/supervisor agenda:
   INSERT siso_inventario_sessoes (
     tipo='cycle_count', galpao_id, modo_contagem='blind',
     tolerancia_pct=2.0, programada_para=tomorrow
   )
   INSERT siso_inventario_areas (sessao_id, nome='Cycle 2026-05-08 - Curva A', operador_id=optional)
   INSERT siso_inventario_localizacoes (sessao_id, area_id, [list of localizacao_id])
   status='planejada'

2. Operador inicia (ou cron na data programada):
   UPDATE sessao SET status='em_andamento', iniciada_em=now()
   Pra cada localização da sessão:
     INSERT siso_localizacao_locks (motivo='cycle_count')
   Roteamento agora exclui essas linhas.

3. Operador conta:
   - Abre sua área (UI lista localizações pendentes)
   - Pega próxima: UPDATE siso_inventario_localizacoes
       SET status='em_contagem', bloqueada_por=user, bloqueada_em=now()
       WHERE id=X AND bloqueada_por IS NULL  -- atômico, anti-colisão
   - Bipa cada item (escaneia GTIN → resolve produto)
   - INSERT siso_inventario_contagens (qty_contada, rodada=1)
   - Modo blind: UI não mostra saldo esperado, só registra
   - Finaliza localização: UPDATE status='contada', libera bloqueada_por

4. Sistema computa divergências da localização:
   Pra cada quádrupla com saldo > 0 ou contagem > 0:
     delta = qty_contada - saldo_sistema
     SE delta = 0:
       Marca localização como 'aprovada' (sem divergência)
     SE delta != 0 e |delta_pct| <= tolerancia_pct:
       INSERT siso_inventario_divergencias (status='aprovada')
     SE delta != 0 e |delta_pct| > tolerancia_pct:
       INSERT siso_inventario_divergencias (status='pendente')
       UPDATE localização SET status='divergente'
     SE valor_financeiro > exige_aprovacao_acima_valor:
       Força status='pendente' independente de tolerância

5. Admin/supervisor revisa divergências pendentes (dashboard dedicado):
   - Solicitar re-contagem: UPDATE divergência SET status='recontagem_solicitada'
       UPDATE localização SET status='recontagem', bloqueada_por=NULL
       Operador (idealmente outro, anti-viés) conta novamente: INSERT contagens com rodada=2
       Sistema reavalia divergência usando rodada mais recente
   - Aprovar manualmente: status='aprovada' com observação
   - Rejeitar: status='rejeitada' (não vai gerar mov no ledger)

6. Quando todas as localizações estão 'aprovada' OU 'pendente=0':
   UPDATE sessao SET status='revisao' (auto)
   Admin clica "Aprovar sessão": UPDATE status='aprovada', aprovada_por=user

7. Aplicação automática:
   Pra cada divergência com status='aprovada':
     BEGIN;
       SELECT siso_estoque WHERE quadrupla FOR UPDATE
       INSERT mov tipo='E' ou 'S' origem='inventario' delta
       UPDATE siso_estoque: saldo = qty_contada_final
       UPDATE divergência: status='aplicada', mov_aplicada_id=...
     COMMIT;
   UPDATE sessao SET status='aplicada', aplicada_em=now()
   Libera todos os locks da sessão.
```

**Política operacional cycle count:**
- Curva A (alto giro): mensal
- Curva B (médio giro): trimestral
- Curva C (baixo giro): semestral
- Tempo médio por localização: 5-15 min. Lock > 2h sem atividade = alerta supervisor.
- Modo `blind` recomendado pra cycle counts regulares (antifraude).
- Tolerância default: 2% pra SKUs comuns; 0% pra SKUs alto valor.

#### 5.7.3 Inventário completo (galpão inteiro, multi-operador, realtime)

Sessão grande cobrindo todas as localizações ativas do galpão. Múltiplos operadores em paralelo, cada um numa área. Operação do galpão pausa parcialmente (separação, transferências bloqueadas; vendas novas vão pra fila).

**Fluxo:**

```
1. Admin programa (idealmente fim de expediente ou domingo):
   INSERT sessao (tipo='completo', galpao_id, modo_contagem='blind')
   Divide galpão em N áreas (N = número de operadores disponíveis)
     ex: Área Norte (corredor A-B), Área Sul (C-D), Overstock (Z)
   INSERT siso_inventario_areas (uma por área, com operador_id atribuído)
   INSERT siso_inventario_localizacoes (todas as localizações do galpão, distribuídas por área)
   status='planejada'

2. Iniciar (admin clica "Iniciar"):
   UPDATE sessao SET status='em_andamento', iniciada_em=now()
   INSERT siso_localizacao_locks pra TODAS as localizações ativas do galpão
   Sistema bloqueia globalmente:
     - Reservas novas pra essas localizações falham
     - Roteamento de pedidos novos vai pra outro galpão (se cobrir) ou OC
     - Operações WMS (transferência, replenishment, ajustes) bloqueadas no galpão

3. Operadores em paralelo:
   Cada operador abre sua tela (web ou handheld) e vê:
     - Lista das localizações da sua área
     - Progresso global (X% do galpão contado)
     - Status de outras áreas (operadores e progresso)
     - Saldo total contado vs saldo total esperado (atualizado realtime)
   Cada operador conta sua área independentemente, com mesma mecânica do cycle count.

4. Realtime via Supabase:
   Cada operador (e admin) faz subscribe em channel `inventario:{sessao_id}`:
     - INSERT em siso_inventario_contagens → propaga pra todos
     - UPDATE em siso_inventario_localizacoes → propaga (status mudou)
     - UPDATE em siso_inventario_areas → propaga
   Saldo agregado é recalculado client-side a partir das contagens recebidas:
     totalContado = sum(qty_contada para todas contagens da sessão)
     totalEsperado = sum(saldo no snapshot inicial)
     progresso = localizações 'contada' ou 'aprovada' / total localizações
   Update de UI sub-segundo.

5. Anti-colisão entre operadores:
   Quando operador "pega" uma localização:
     UPDATE siso_inventario_localizacoes
       SET bloqueada_por=user, bloqueada_em=now(), status='em_contagem'
       WHERE id=X AND bloqueada_por IS NULL  -- atômico
   Se 0 rows affected: outro operador pegou primeiro; UI alerta.
   Cron de cleanup: locks com bloqueada_em > 30min sem contagem nova → libera.

6. Modo duplo_blind (opcional, pra alta criticidade):
   Sessão tem 2 áreas duplicadas cobrindo mesmas localizações.
   Operador 1 conta na "Área 1", operador 2 conta na "Área 1 paralela" (ambas blind).
   Sistema só compara após ambos terminarem:
     SE rodada1.qty == rodada2.qty: aprovado direto
     SE divergir: 3ª contagem por supervisor

7. Após todas áreas concluídas:
   UPDATE sessao SET status='revisao'
   Admin abre dashboard de divergências consolidadas:
     - Filtro por valor financeiro, % de erro, área, operador
     - Pode aprovar em lote (todas dentro tolerância)
     - Pode solicitar re-contagem de itens específicos
     - Pode aprovar manualmente cada divergência

8. Aprovação e aplicação:
   Mesma mecânica do cycle count (geração de movs no ledger em transação atômica por divergência).
   Após aplicação: UPDATE sessao SET status='aplicada'
   Libera todos os locks; operação do galpão volta ao normal.

9. Relatórios pós-inventário:
   - Acuracidade global: % localizações sem divergência
   - Divergência financeira total
   - Divergência por área/operador (acuracidade individual)
   - Top SKUs com maior erro (candidatos a investigação)
   - Snapshot exportável pra SPED Bloco H (inventário fiscal anual obrigatório no BR)
```

**Implementação realtime (Supabase):**

```typescript
// hook na tela de inventário (operador ou admin)
function useInventarioRealtime(sessaoId: string) {
  const [contagens, setContagens] = useState<Contagem[]>([]);
  const [localizacoes, setLocalizacoes] = useState<LocalizacaoSessao[]>([]);

  useEffect(() => {
    const channel = supabase
      .channel(`inventario:${sessaoId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'siso_inventario_contagens',
        filter: `sessao_id=eq.${sessaoId}`,
      }, ({ new: c }) => setContagens(prev => [...prev, c]))
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'siso_inventario_localizacoes',
        filter: `sessao_id=eq.${sessaoId}`,
      }, ({ new: l }) => setLocalizacoes(prev => prev.map(x => x.id === l.id ? l : x)))
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [sessaoId]);

  // saldo agregado calculado client-side a partir das contagens
  const totalContado = useMemo(
    () => contagens.reduce((s, c) => s + Number(c.qty_contada), 0),
    [contagens]
  );

  const progresso = useMemo(() => {
    const concluidas = localizacoes.filter(l =>
      ['contada', 'aprovada'].includes(l.status)
    ).length;
    return localizacoes.length > 0 ? concluidas / localizacoes.length : 0;
  }, [localizacoes]);

  return { contagens, localizacoes, totalContado, progresso };
}
```

**Performance:** sessão de 1000 localizações com 5 operadores → ~5000 contagens em 4-6h. Supabase Realtime aguenta tranquilamente; recomenda paginação na UI (mostrar últimas N contagens, total agregado calculado server-side via RPC se ficar pesado).

**Política operacional inventário completo:**
- Programar com antecedência (avisar marketplaces/clientes de eventual atraso em pedidos novos)
- Idealmente fora de horário comercial (sábado tarde, domingo)
- Mínimo 2 operadores; ideal 4-6 pra galpão médio
- Modo `blind` ou `duplo_blind` obrigatório se for inventário fiscal anual
- Backup do ledger antes de aplicar (snapshot DB no momento de status='revisao')

#### 5.7.4 Métricas de acuracidade

```sql
-- Acuracidade por localização (últimas 5 contagens)
SELECT
  l.codigo,
  COUNT(DISTINCT il.sessao_id) as total_contagens,
  COUNT(DISTINCT CASE WHEN d.delta = 0 OR d.id IS NULL THEN il.sessao_id END) as sem_divergencia,
  AVG(ABS(d.delta_pct)) as divergencia_media_pct
FROM siso_inventario_localizacoes il
JOIN siso_localizacoes l ON l.id = il.localizacao_id
LEFT JOIN siso_inventario_divergencias d
  ON d.localizacao_id = il.localizacao_id AND d.sessao_id = il.sessao_id
WHERE il.criado_em >= now() - interval '6 months'
GROUP BY l.id, l.codigo
ORDER BY divergencia_media_pct DESC NULLS LAST;

-- Acuracidade por operador (últimos 30 dias)
SELECT
  u.nome,
  COUNT(DISTINCT c.localizacao_id) as localizacoes_contadas,
  AVG(ABS(d.delta_pct)) FILTER (WHERE d.id IS NOT NULL) as erro_medio_pct,
  SUM(ABS(d.valor_financeiro)) FILTER (WHERE d.id IS NOT NULL) as impacto_financeiro_total
FROM siso_inventario_contagens c
JOIN siso_usuarios u ON u.id = c.contada_por
LEFT JOIN siso_inventario_divergencias d
  ON d.sessao_id = c.sessao_id
  AND d.localizacao_id = c.localizacao_id
  AND d.produto_id = c.produto_id
  AND d.empresa_dona_id = c.empresa_dona_id
WHERE c.criado_em >= now() - interval '30 days'
GROUP BY u.id, u.nome
ORDER BY erro_medio_pct DESC NULLS LAST;

-- Cobertura de cycle count (% localizações contadas em cada janela)
SELECT
  COUNT(DISTINCT l.id) as total_localizacoes_ativas,
  COUNT(DISTINCT CASE
    WHEN il.criado_em >= now() - interval '30 days' THEN l.id
  END) as contadas_30d,
  COUNT(DISTINCT CASE
    WHEN il.criado_em >= now() - interval '90 days' THEN l.id
  END) as contadas_90d,
  COUNT(DISTINCT CASE
    WHEN il.criado_em >= now() - interval '180 days' THEN l.id
  END) as contadas_180d
FROM siso_localizacoes l
LEFT JOIN siso_inventario_localizacoes il ON il.localizacao_id = l.id
WHERE l.ativo = true;
```

Métricas alimentam dashboard de qualidade de inventário (§8.3 ganha link). Operador com erro recorrente alto recebe treinamento; localização problemática vira candidato a re-slotting.

### 5.8 Troca de SKU na separação

Operador na separação identifica que vai entregar SKU-Y no lugar de SKU-X (substituto válido, equivalente registrado no módulo Cross).

```
Validação prévia: Y precisa ser equivalente registrado de X no Cross.
  (módulo Cross já existe; UI bloqueia troca livre fora dessas equivalências)

Em transação atômica:
  -- Estorna reserva do original X (libera o reservado dele)
  INSERT mov tipo='L' origem='troca_sku_out'
    produto=X, dona, galpao, localizacao (a quádrupla onde X estava reservado)
    observacoes='trocado por Y, pedido N'
  UPDATE siso_estoque(X): reservado -= qty

  -- Cria reserva do substituto Y (na quádrupla onde Y tem disponível)
  INSERT mov tipo='R' origem='troca_sku_in'
    produto=Y, dona, galpao, localizacao
    expira_em = now() + 48h
    observacoes='substitui X no pedido N'
  UPDATE siso_estoque(Y): reservado += qty

Quando NF é emitida com SKU-Y (worker já gera NF com Y):
  INSERT mov tipo='S' origem='nf_venda', produto=Y
  INSERT mov tipo='L' origem='liberacao_reserva', produto=Y
```

**Auditoria:** mesmo `origem_id` (id do pedido) liga as 4 movs (out + in + S + L). Histórico do pedido mostra: "originalmente X, trocado por Y, NF emitida com Y".

**Resolução de dona/galpão pra Y:** mesma lógica de roteamento (§6) — busca Y primeiro próprio no galpão atual, depois empréstimo. Se Y não está disponível em nenhum galpão atendível, troca não pode ser feita; operador precisa cancelar o pedido ou propor outra solução.

### 5.9 Cancelamento de pedido

**Antes da NF:** apenas libera reserva.

```
INSERT mov tipo='L' origem='liberacao_reserva' observacoes='cancelamento de pedido'
UPDATE siso_estoque: reservado -= qty
```

**Depois da NF:** opera via NF de devolução (fluxo 5.4) ou via cancelamento de NF no Tiny (fluxo 5.10).

### 5.10 Cancelamento de NF (webhook do Tiny)

```
Webhook cancelamento_nf chega.
Sistema identifica mov de saída original via nota_fiscal_id.

INSERT mov tipo='E' origem='cancelamento_nf' (inversa da saída)
  estorno_de = id da mov original
UPDATE siso_estoque: saldo += qty (na mesma quádrupla original)

Se a mov original era 'emprestimo': empréstimo é desfeito automaticamente
  (a query agregada de saldo devedor — §11.2 — ignora movs com estorno_de preenchido).
```

### 5.11 Lançamento retroativo (entrada de emergência / cross-docking implícito)

**Cenário:** mercadoria chegou fisicamente ao galpão mas o operador de recebimento ainda não fez o lançamento formal. Operador da separação (ou outro fluxo) tenta bipar SKU pra atender pedido. Saldo no SISO está zero ou insuficiente. Sem este fluxo, separação fica engessada esperando recebimento — operador frustrado, pedido atrasa.

**Fluxo:**

```
Operador na separação bipa SKU. Sistema verifica saldo na quádrupla de origem.

Se saldo insuficiente:
  UI alerta: "Saldo registrado: 0 (ou X). Você está com a mercadoria em mãos?"
  [Sim, lançar entrada de emergência]  [Não, sem estoque]

Se operador confirma "Sim":
  UI pergunta:
    - Qty a lançar (default = qty necessária pra atender o pedido)
    - Localização (default = localização default do galpão; ou onde estava sendo bipado)
    - Empresa dona (default = empresa do pedido sendo separado)
    - Fornecedor (opcional, ajuda na reconciliação posterior)
    - Observação (campo livre)

  Em transação atômica:
    INSERT mov tipo='E' origem='lancamento_retroativo'
      observacoes = 'emergência: separação pedido N; aguarda reconciliação com NF de entrada'
      origem_detalhes = { pedido_id, fornecedor_id?, motivo }
    UPDATE siso_estoque: saldo += qty
    -- Em seguida o fluxo normal de saída segue (reserva e/ou venda)

Sistema marca o lançamento como pendente de reconciliação (query, não coluna).
```

**Reconciliação posterior:**

Quando recebimento formal lança a NF de entrada (`compra_manual`), sistema procura `lancamento_retroativo` pendente compatível (mesmo SKU, mesma empresa, janela temporal de N dias, qty <= qty da NF) e oferece:

```
Sistema detecta match: "Há 12 unidades lançadas como retroativo nos últimos 7 dias.
                       Reconciliar com esta entrada?"

Operador confirma:
  Em transação atômica:
    INSERT mov tipo='S' origem='estorno' qty=qty_retroativa
      estorno_de = id_da_mov_retroativa
      observacoes = 'reconciliado com NF X'
    A entrada formal (compra_manual) já foi inserida normalmente; net efeito = qty da NF.
    UPDATE siso_estoque: já refletido pelas duas movs.
```

**Dashboard:** lançamentos retroativos não-reconciliados aparecem em "Pendências de reconciliação" (§8.4 dashboard geral). Operador pode reconciliar manualmente ou marcar como "definitivo" (mercadoria chegou sem NF, ajuste contábil é o que vale).

**Política operacional:**
- Lançamento retroativo é **exceção, não regra**. Limite diário por operador (alerta acima de N/dia).
- Auditoria: relatório semanal de lançamentos retroativos por operador (frequência alta = sintoma de processo de recebimento ineficiente).
- Reconciliação obrigatória em até 7 dias; após isso, alerta vira crítico.

## 6. Algoritmo de roteamento

**Princípio:** todos os itens do pedido têm que caber num único galpão (próprio ou via empréstimo). Sem split shipment. Se cobertura exige >1 galpão → vai pra OC.

Pseudocódigo TypeScript:

```typescript
type ItemPedido = { produto_id: string; qty: number };
type RotaItem = {
  produto_id: string;
  qty: number;
  empresa_dona_id: string;
  galpao_id: string;
  localizacao_id: string;
  tipo: 'propria' | 'emprestimo';
};
type RotaResult =
  | { decisao: 'propria'; rotas: RotaItem[] }
  | { decisao: 'emprestimo'; rotas: RotaItem[] }    // todos no mesmo galpão, mas há empréstimo
  | { decisao: 'oc'; motivo: 'sem_cobertura' | 'split_galpoes' };

async function rotearPedido(
  empresaVendedoraId: string,
  itens: ItemPedido[],
): Promise<RotaResult> {
  const homeGalpao = await getHomeGalpao(empresaVendedoraId);
  const galpoesAtivos = await listarGalpoesAtivos();
  const credoras = await getCredorasPara(empresaVendedoraId); // de siso_emprestimo_regras

  // 1. Pra cada galpão, tenta cobrir TODOS os itens
  const candidatos: { galpao: Galpao; rotas: RotaItem[]; tudoProprio: boolean }[] = [];

  for (const galpao of galpoesAtivos) {
    const rotas: RotaItem[] = [];
    let cobreTudo = true;
    let tudoProprio = true;

    for (const item of itens) {
      // Tenta próprio nesse galpão (preferindo localização tipo='picking')
      const proprio = await buscarLinhaEstoque({
        produto_id: item.produto_id,
        empresa_dona_id: empresaVendedoraId,
        galpao_id: galpao.id,
        qty_min: item.qty,
        ignora_locks: false,
      });
      if (proprio) {
        rotas.push({ ...item, ...proprio, tipo: 'propria' });
        continue;
      }

      // Tenta empréstimo nesse galpão (qualquer credora autorizada com disponível)
      const emprestimo = await buscarLinhaEstoque({
        produto_id: item.produto_id,
        empresa_dona_id__in: credoras,
        galpao_id: galpao.id,
        qty_min: item.qty,
        ignora_locks: false,
      });
      if (emprestimo) {
        rotas.push({ ...item, ...emprestimo, tipo: 'emprestimo' });
        tudoProprio = false;
        continue;
      }

      cobreTudo = false;
      break;
    }

    if (cobreTudo) candidatos.push({ galpao, rotas, tudoProprio });
  }

  if (candidatos.length === 0) {
    return { decisao: 'oc', motivo: 'sem_cobertura' };
  }

  // 2. Ordena por prioridade geográfica
  candidatos.sort((a, b) => geoPriority(a.galpao, homeGalpao) - geoPriority(b.galpao, homeGalpao));

  const escolhido = candidatos[0];

  // 3. Decisão final
  return {
    decisao: escolhido.tudoProprio ? 'propria' : 'emprestimo',
    rotas: escolhido.rotas,
  };
}

function geoPriority(galpao: Galpao, home: Galpao): number {
  if (galpao.id === home.id) return 0;
  if (galpao.cidade === home.cidade && galpao.estado === home.estado) return 1;
  if (galpao.estado === home.estado) return 2;
  return 3;
}

async function buscarLinhaEstoque(filtros): Promise<EstoqueLine | null> {
  return db.query(`
    SELECT e.*
    FROM siso_estoque e
    WHERE e.produto_id = $1
      AND e.empresa_dona_id = ANY($2)
      AND e.galpao_id = $3
      AND e.disponivel >= $4
      AND NOT EXISTS (
        SELECT 1 FROM siso_localizacao_locks l
        WHERE l.localizacao_id = e.localizacao_id
          AND l.finalizado_em IS NULL
      )
    ORDER BY
      CASE WHEN loc.tipo = 'picking' THEN 0 ELSE 1 END,  -- picking antes de overstock
      e.disponivel DESC
    LIMIT 1
  `, [...]);
}
```

**Decisões:**
- `decisao='propria'`: auto-aprova (todos os itens do mesmo galpão e do dono = vendedora)
- `decisao='emprestimo'`: vai pra painel humano (todos no mesmo galpão, mas algum item é empréstimo)
- `decisao='oc'`: vai pra módulo de compras (cobertura exige >1 galpão ou simplesmente não tem)

**Lock de localização ignorado nos cálculos:** se a única linha que cobreria está numa localização travada, sistema age como se não existisse. Pode levar pedido a OC durante uma sessão de cycle count — política operacional minimiza isso (cycle count em baixo giro/fora de pico).

## 7. Reservas, concorrência e TTL

### 7.1 Lock pessimista por linha

Postgres serializa transações concorrentes na mesma linha de `siso_estoque` via `SELECT FOR UPDATE`.

```typescript
async function reservar(
  produtoId: string,
  donaId: string,
  galpaoId: string,
  localizacaoId: string,
  qty: number,
  pedidoId: string,
  ttlHoras = 48,
) {
  return await db.transaction(async (tx) => {
    // Verifica lock de localização (cycle count)
    const lockAtivo = await tx.query(`
      SELECT 1 FROM siso_localizacao_locks
      WHERE localizacao_id = $1 AND finalizado_em IS NULL
    `, [localizacaoId]);
    if (lockAtivo.rows[0]) {
      throw new LocalizacaoBloqueadaError({ localizacaoId });
    }

    const { rows: [estoque] } = await tx.query(`
      SELECT saldo, reservado FROM siso_estoque
      WHERE produto_id=$1 AND empresa_dona_id=$2
        AND galpao_id=$3 AND localizacao_id=$4
      FOR UPDATE
    `, [produtoId, donaId, galpaoId, localizacaoId]);

    if (!estoque || estoque.saldo - estoque.reservado < qty) {
      throw new EstoqueInsuficienteError({ produtoId, donaId, galpaoId, localizacaoId, qty });
    }

    const expiraEm = new Date(Date.now() + ttlHoras * 3600 * 1000);

    await tx.query(`
      INSERT INTO siso_movimentacoes (
        produto_id, empresa_dona_id, galpao_id, localizacao_id,
        tipo, quantidade,
        saldo_anterior, saldo_posterior,
        reservado_anterior, reservado_posterior,
        origem_tipo, origem_id, expira_em, criado_em
      ) VALUES (
        $1, $2, $3, $4, 'R', $5,
        $6, $6,
        $7, $7 + $5,
        'reserva_pedido', $8, $9, now()
      )
    `, [produtoId, donaId, galpaoId, localizacaoId, qty,
        estoque.saldo, estoque.reservado, pedidoId, expiraEm]);

    await tx.query(`
      UPDATE siso_estoque
      SET reservado = reservado + $1, atualizado_em = now()
      WHERE produto_id=$2 AND empresa_dona_id=$3
        AND galpao_id=$4 AND localizacao_id=$5
    `, [qty, produtoId, donaId, galpaoId, localizacaoId]);
  });
}
```

**Granularidade do lock:** apenas a linha `(produto, dona, galpão, localização)`. Outras linhas (mesmo produto em outra localização, ou dona diferente) não esperam.

**Ordem determinística pra multi-item:** sempre `ORDER BY produto_id ASC` antes de adquirir locks, pra evitar deadlock entre pedidos concorrentes.

**Timeout:** se lock fica >5s segurado, retry com backoff exponencial. Se persistir após 3 tentativas, pedido vai pra painel humano.

### 7.2 TTL de 48h em reservas

Toda mov `tipo='R'` tem `expira_em = now() + 48h`. Cron job de hora em hora:

```sql
-- Reservas expiradas que ainda não foram liberadas
WITH expiradas AS (
  SELECT R.* FROM siso_movimentacoes R
  WHERE R.tipo = 'R'
    AND R.expira_em < now()
    AND NOT EXISTS (
      SELECT 1 FROM siso_movimentacoes L
      WHERE L.origem_id = R.origem_id
        AND L.tipo = 'L'
        AND L.criado_em > R.criado_em
    )
)
SELECT * FROM expiradas;
```

Pra cada reserva expirada, em transação:

```sql
BEGIN;
  -- Lock na linha de estoque
  SELECT * FROM siso_estoque WHERE (quadrupla) FOR UPDATE;

  -- Insere liberação
  INSERT INTO siso_movimentacoes (
    ... tipo='L' origem='liberacao_reserva' ...
    observacoes = 'expirado: reserva sem NF em 48h, pedido N'
  );

  -- Atualiza cache
  UPDATE siso_estoque SET reservado = reservado - qty;

  -- Marca pedido como necessitando atenção
  UPDATE siso_pedidos SET status_alerta = 'reserva_expirada' WHERE id = pedido_id;
COMMIT;

-- Loga e dispara alerta no painel
```

**Alerta operacional:** pedidos com reserva expirada aparecem em fila dedicada no painel. Operador investiga (cliente cancelou? worker travou? NF rejeitada pelo Tiny?) e age (re-reservar, cancelar, escalonar).

## 8. Dashboard de avisos (cobertura por giro)

Tela de monitoramento estoque com alertas baseados em **dias de cobertura** (saldo dividido pelo giro diário médio dos últimos 30 dias).

### 8.1 View de cobertura

```sql
CREATE MATERIALIZED VIEW siso_cobertura_estoque AS
WITH giro_30d AS (
  SELECT
    produto_id,
    empresa_dona_id,
    galpao_id,
    SUM(quantidade) / 30.0 AS giro_diario
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda', 'emprestimo')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id, empresa_dona_id, galpao_id
),
saldo_agregado AS (
  -- Soma do disponivel em todas as localizações daquela tripla (produto, dona, galpão)
  SELECT
    produto_id,
    empresa_dona_id,
    galpao_id,
    SUM(disponivel) AS disponivel_total
  FROM siso_estoque
  GROUP BY produto_id, empresa_dona_id, galpao_id
)
SELECT
  s.produto_id,
  s.empresa_dona_id,
  s.galpao_id,
  s.disponivel_total,
  COALESCE(g.giro_diario, 0) AS giro_diario,
  CASE
    WHEN g.giro_diario > 0 THEN s.disponivel_total / g.giro_diario
    ELSE NULL
  END AS dias_cobertura,
  CASE
    WHEN g.giro_diario IS NULL OR g.giro_diario = 0 THEN 'sem_giro'
    WHEN s.disponivel_total / g.giro_diario < 7 THEN 'critico'
    WHEN s.disponivel_total / g.giro_diario < 14 THEN 'atencao'
    ELSE 'ok'
  END AS status_cobertura
FROM saldo_agregado s
LEFT JOIN giro_30d g USING (produto_id, empresa_dona_id, galpao_id);

CREATE UNIQUE INDEX uq_cobertura
  ON siso_cobertura_estoque(produto_id, empresa_dona_id, galpao_id);

CREATE INDEX idx_cobertura_status
  ON siso_cobertura_estoque(status_cobertura, dias_cobertura);
```

**Refresh:** materialized view atualizada por cron diário (03h da manhã). Cálculo de giro não precisa ser real-time.

### 8.2 Categorias de alerta

| Status | Critério | Ação sugerida |
|---|---|---|
| 🔴 **Crítico** | < 7 dias de cobertura | Comprar urgente; considerar empréstimo de outro galpão |
| 🟡 **Atenção** | < 14 dias de cobertura | Programar reposição |
| ⚪️ **OK** | ≥ 14 dias | Sem ação |
| ⚫️ **Sem giro** | Zero saídas em 30 dias | Avaliar discontinuação ou liquidação |

### 8.3 Alertas adicionais (mesma tela)

- **Reservas expiradas pendentes** (§7.2): pedidos com reserva órfã aguardando ação humana.
- **Replenishment sugerido**: localização de picking com cobertura < 7 dias, mas overstock no mesmo galpão tem saldo. Sugere transferência intra-galpão.
- **Localizações em cycle count**: lista locks ativos > 1h (possivelmente esquecidos).
- **Empréstimos crescendo unilateralmente**: saldo devedor entre par credora↔devedora cresceu > 20% no último mês — alerta pra acerto.
- **Cobertura cruzada com lead time**: SKU com `dias_cobertura < lead_time_medio` do fornecedor preferencial — risco real de ruptura (não basta < 14 dias se fornecedor demora 21 dias).
- **Lançamentos retroativos pendentes**: entradas de emergência aguardando reconciliação > 3 dias.

### 8.4 Dashboard geral de eventos críticos

Tela única que centraliza todos os alertas operacionais do WMS, agrupados por severidade. Substitui ter que abrir N telas pra ver o estado global.

**Layout (cartões por categoria):**

```
┌─ COBERTURA ──────────────────────┐  ┌─ INVENTÁRIO ─────────────────┐
│ 🔴 Crítico (< lead time):  12    │  │ Sessões ativas:           2  │
│ 🟡 Atenção (< 14 dias):    34    │  │ Divergências pendentes:  18  │
│ ⚫ Sem giro 30d:           87    │  │ Locks > 1h:               1  │
└──────────────────────────────────┘  │ Sessões órfãs > 24h:      0  │
                                       └──────────────────────────────┘
┌─ RESERVAS ───────────────────────┐  ┌─ EMPRÉSTIMOS ────────────────┐
│ Expiradas (libera em < 6h):  3   │  │ Pares com saldo > R$ 50k: 2  │
│ Expiradas pendentes:          5  │  │ Crescimento > 20% / mês:  1  │
│ Lançamentos retroativos       │  │                              │
│ não reconciliados:            7  │  └──────────────────────────────┘
└──────────────────────────────────┘

┌─ REPLENISHMENT SUGERIDO ─────────────────────────────────────────────┐
│ 23 localizações de picking com overstock disponível pra repor        │
└──────────────────────────────────────────────────────────────────────┘
```

**Cada cartão** tem link pra tela específica de tratamento (drill-down). Refresh a cada 30s ou via Supabase Realtime se a tela suportar.

**Permissão de visualização:** todos os cargos veem; ações ficam restritas conforme role (cargo `supervisor_logistica` em v1.x+).

**Notificações push (mobile/desktop):** v2 — em v1, alertas só aparecem ao abrir a tela. Email/Slack opt-in fica pra próxima iteração.

## 9. Integração Tiny

### 9.1 SISO → Tiny (chamadas que SISO faz)

| Operação | Status | Notas |
|---|---|---|
| `getProdutoDetalhe` | ✅ Mantém | Lazy-load do catálogo SISO |
| `buscarProdutoPorSku` | ✅ Mantém | Resolve mapeamento por empresa |
| `getPedido` | ✅ Mantém | Detalhes do pedido pro processamento |
| `gerarNotaFiscal` | ✅ Mantém | Fiscal essencial |
| `criarMarcadoresPedido` | ✅ Mantém | Tagging |
| `criarAgrupamento` (etiqueta) | ✅ Mantém | Fluxo de expedição |
| `getEstoque` | ❌ Remove | Substituído por query SISO |
| `movimentarEstoque` | ❌ Remove | SISO grava direto no ledger |
| `lancarEstoqueNota` | ❌ Remove | SISO grava S no ledger via webhook |
| `estornarEstoque` | ❌ Remove | SISO faz mov estorno |

### 9.2 Tiny → SISO (webhooks que SISO escuta)

| Webhook | Decisão | Ação no SISO |
|---|---|---|
| Pedido novo | ✅ Mantém | Roteamento + reserva |
| NF venda autorizada | ✅ Mantém | Mov S + L |
| NF devolução | ✅ Adicionar | Insere em `siso_devolucoes_pendentes` |
| NF cancelada | ✅ Adicionar | Mov estorno automático |
| Estoque alterado manualmente | ❌ Ignora | Tiny saldo é fictício |

### 9.3 Saldo Tiny vai divergir — e tudo bem

Tiny não rejeita NF por saldo zero (confirmado pelo user). NF de venda emitida → Tiny saldo da empresa cai pra negativo livremente. Sem compensação no Tiny.

Time é orientado: **não olhar saldo no Tiny pra decidir nada operacional**. Verdade está no SISO.

## 10. Marketplace sync (escopo v2, não v1)

Marketplaces (ML, Shopee) puxam estoque do Tiny. Com Tiny saldo virando fictício, anúncios vão mostrar fora de estoque mesmo quando SISO sabe que tem.

V1 não trata. V2 vai precisar de estratégia:
- Push periódico de SISO pro Tiny (atualiza saldo do produto baseado em SISO)
- Estratégia conservadora (só próprio) ou otimista (próprio + emprestável) ou rateada
- Discussão a ter no momento do escopo v2.

## 11. Migração em fases

### Fase 0 — WMS standalone (zero acoplamento)

**Duração estimada:** 7-10 semanas (revisada com módulo de inventário robusto).

**O que muda:**
- Cria tabelas novas:
  - `siso_produtos` (com cest, origem_fiscal, sincronizado_em)
  - `siso_produto_empresas`
  - `siso_fornecedores`
  - `siso_produto_fornecedores` (com lead_time)
  - `siso_localizacoes`
  - `siso_estoque`
  - `siso_movimentacoes`
  - `siso_emprestimo_regras`
  - `siso_localizacao_locks`
  - `siso_devolucoes_pendentes`
  - `siso_inventario_sessoes`
  - `siso_inventario_areas`
  - `siso_inventario_localizacoes`
  - `siso_inventario_contagens`
  - `siso_inventario_divergencias`
- Adiciona colunas em `siso_galpoes` (cidade, estado, país).
- Adiciona cargo `supervisor_logistica` em `siso_usuarios.cargo` (sem restrições aplicadas em v1; roles entram em v1.x+).
- Materialized view `siso_cobertura_estoque` + cron diário.
- Cron jobs: TTL de reservas (1h), reconciliação ledger↔estoque (1h), refresh cobertura (diário 03h), cleanup de bloqueios de inventário órfãos (10min), detecção de sessões de inventário órfãs (4h), alerta de lançamentos retroativos não reconciliados (diário).
- Sync com Tiny: serviço (`produto-fetcher.ts` reutilizado do módulo Cross) atualiza catálogo a cada webhook de pedido.
- Telas novas no SISO (rota `/wms/*`):
  - **Cadastros:**
    - Catálogo de produtos (CRUD; sync automático com Tiny)
    - Mapeamento produto ↔ empresa Tiny
    - Fornecedores (CRUD com prefixo SKU, CNPJ)
    - Produto ↔ Fornecedor (CRUD com lead time min/médio/max, qty mínima, múltiplo, custo, preferencial)
    - Configuração de galpões (cidade, estado)
    - Configuração de localizações por galpão (CRUD com tipo)
    - Matriz de empréstimos
  - **Operação:**
    - Receber estoque (entrada manual com sugestão automática de localização)
    - Transferir entre galpões (inter-galpão)
    - Replenishment (intra-galpão, entre localizações)
    - Ajuste manual
    - Troca de SKU (se separação habilitar antes da Fase 3)
    - Lançamento retroativo (modal acionado da separação quando saldo zero, com fluxo de reconciliação)
  - **Inventário (módulo robusto):**
    - Programar sessão de cycle count (escolher localizações, atribuir operadores, configurar tolerância e modo blind)
    - Programar sessão de inventário completo (dividir galpão em áreas, atribuir operadores)
    - Tela de contagem do operador (web + handheld) com scanner GTIN, modo blind toggleable, anti-colisão
    - Painel realtime da sessão (admin/supervisor): progresso global, status por área/operador, saldo total contado vs esperado, divergências surgindo, locks em andamento
    - Dashboard de divergências pendentes: filtros, aprovação em lote, solicitar re-contagem
    - Aprovação final da sessão (admin)
    - Métricas de acuracidade: por localização, por operador, cobertura de cycle count
    - Histórico de sessões (drill-down até ledger via `mov_aplicada_id`)
  - **Visualização:**
    - Saldos (4 perspectivas: por dono, por galpão, por localização, por produto)
    - Ledger (filtros por origem, produto, período, etc)
    - Dashboard de empréstimos pendentes (saldos credora ↔ devedora)
    - Dashboard geral de eventos críticos (cartões agrupados: cobertura, inventário, reservas, empréstimos, replenishment, lançamentos retroativos pendentes)
    - Reconciliação de lançamentos retroativos (lista de pendentes, ação de match com NF de entrada)
- Snapshot inicial: bulk-load de saldo atual do Tiny pra `siso_estoque` (uma vez, marca como `inventario_inicial`). Localização default = `DEFAULT-PICKING` por galpão.

**O que NÃO muda:**
- Webhook de pedido continua usando o fluxo atual (Tiny `getEstoque`).
- Decisão de roteamento continua usando schema legado.
- Worker continua chamando `lancarEstoqueNota` no Tiny.
- UI de pedidos/separação/compras inalterada.

**Critério de saída:** time validou todas as funcionalidades isoladamente. Catálogo populado, matriz configurada, entradas manuais funcionando, transferências e ajustes funcionando, cycle count rodando, dashboard com dados consistentes, ledger consistente em testes.

**Reversão:** trivial (drop tables, remover rotas).

### Fase 1 — Dual-write (escreve nos dois lados, lê do legado)

**Duração estimada:** 2-4 semanas.

**O que muda:**
- Webhook de pedido, ao processar, **adiciona escrita paralela** no novo ledger:
  - Reserva: insere mov R + UPDATE siso_estoque (com quádrupla)
  - NF webhook: insere mov S + L + UPDATE siso_estoque
- Worker continua chamando Tiny (legado).
- UI de pedidos lê do schema legado.
- Job comparativo roda em background: pra cada pedido novo, compara decisão de roteamento "novo" vs "antigo" e loga divergências.
- TTL de reservas começa a operar (cron de hora em hora).

**O que NÃO muda:**
- Comportamento visível ao operador é idêntico.
- Tiny continua sendo chamado pra estoque.

**Critério de saída:** dual-write rodando estável por 2 semanas, divergências resolvidas, comparativo aponta novo schema = legado em >99% dos casos.

**Reversão:** desligar dual-write (feature flag).

### Fase 2 — Shadow comparison (validação ativa)

**Duração estimada:** 2-4 semanas.

**O que muda:**
- Comparativo dual-write é amadurecido em dashboard com alertas por divergência.
- Operador pode forçar reconciliação manual em casos de divergência.
- Treinamento da equipe na nova UI (saldos, ledger, cobertura, dashboard de empréstimos).
- Inventário físico real começa nessa fase (não no início) — depois que o sistema novo está validado em shadow.

**Critério de saída:** zero divergência por 1 semana. Equipe confortável com nova UI. Inventário físico realizado e divergências reconciliadas via mov `inventario`.

### Fase 3 — Switch parcial (corte por empresa ou por SKU)

**Duração estimada:** 2 semanas.

**O que muda:**
- Liga "primeira leva" no novo schema. Opções:
  - **Por empresa:** NetAir lê do novo, NetParts continua no legado.
  - **Por SKU:** subset de SKUs migrados; resto continua no legado.
- Webhook usa novo roteamento pra SKUs/empresas migrados.
- Worker para de chamar `lancarEstoqueNota` no Tiny **pra esses casos**.
- Tiny continua recebendo NF de venda normal; saldo Tiny começa a divergir pra esses SKUs/empresas.
- Troca de SKU na separação habilitada (depende do novo ledger).

**Critério de saída:** 2 semanas de operação na primeira leva sem incidente operacional.

**Reversão:** flip a feature flag de volta. Schema legado ainda é dual-writed.

### Fase 4 — Switch completo + decoupling

**Duração estimada:** 1-2 semanas.

**O que muda:**
- Todas empresas e todos SKUs no novo schema.
- Worker para de chamar **qualquer** API de estoque do Tiny.
- Schema legado vira read-only.
- Mapeia escopo v2 (marketplace sync, devolução em volume, etc).

**Critério de saída:** todos os pedidos sendo processados corretamente pelo novo. Zero call de estoque pro Tiny.

**Reversão:** rollback complexo. Tem que ser certo.

## 12. Reconciliação e error handling

### 12.1 Job de reconciliação contínua (todas as fases)

```sql
-- Pra cada linha de siso_estoque, valida que saldo bate com ledger
SELECT
  e.produto_id,
  e.empresa_dona_id,
  e.galpao_id,
  e.localizacao_id,
  e.saldo as saldo_estoque,
  COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                    WHEN m.tipo='S' THEN -m.quantidade
                    ELSE 0 END), 0) as saldo_calculado,
  e.saldo - COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                              WHEN m.tipo='S' THEN -m.quantidade
                              ELSE 0 END), 0) as divergencia
FROM siso_estoque e
LEFT JOIN siso_movimentacoes m
  ON m.produto_id = e.produto_id
  AND m.empresa_dona_id = e.empresa_dona_id
  AND m.galpao_id = e.galpao_id
  AND m.localizacao_id = e.localizacao_id
GROUP BY e.produto_id, e.empresa_dona_id, e.galpao_id, e.localizacao_id, e.saldo
HAVING e.saldo <> COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                                    WHEN m.tipo='S' THEN -m.quantidade
                                    ELSE 0 END), 0)
```

Roda a cada 1h. Qualquer divergência = alerta crítico. Em modo automático: REBUILD da linha de `siso_estoque` a partir do ledger (autoritativo).

### 12.2 Saldo devedor por par credora ↔ devedora

Query agregada do ledger (ignora movs estornadas):

```sql
-- "Quanto NetParts deve a NetAir do produto X?"
WITH dividas AS (
  SELECT
    empresa_dona_id as credora,
    emprestimo_devedora_id as devedora,
    produto_id,
    SUM(CASE
      WHEN estorno_de IS NULL AND NOT EXISTS (
        SELECT 1 FROM siso_movimentacoes e2 WHERE e2.estorno_de = m.id
      ) THEN quantidade
      ELSE 0
    END) as devido
  FROM siso_movimentacoes m
  WHERE origem_tipo = 'emprestimo'
  GROUP BY empresa_dona_id, emprestimo_devedora_id, produto_id
)
SELECT
  d1.credora, d1.devedora, d1.produto_id,
  d1.devido - COALESCE(d2.devido, 0) as saldo_liquido
FROM dividas d1
LEFT JOIN dividas d2
  ON d1.credora = d2.devedora
  AND d1.devedora = d2.credora
  AND d1.produto_id = d2.produto_id
WHERE d1.devido > COALESCE(d2.devido, 0);
```

Saldo líquido = empréstimos diretos − empréstimos reversos − estornos. Quando vira zero ou negativo, dívida quitada.

### 12.3 Erros previstos

| Erro | Causa | Tratamento |
|---|---|---|
| `EstoqueInsuficienteError` na reserva | Race com outro pedido | Retry com backoff; se persistir, pedido vai pra painel humano |
| `LocalizacaoBloqueadaError` | Cycle count ativo na localização | Roteamento busca outra localização ou empréstimo; se nada → OC |
| Webhook NF chega antes do pedido | Race natural | Insere em fila `aguardando_pedido` (já implementado) |
| NF venda referencia mov que não existe no ledger | Bug ou dual-write inconsistente | Alerta crítico; operador investiga |
| Devolução chega sem pedido conhecido | NF órfã | Fila manual de classificação |
| Catálogo Tiny mudou tiny_produto_id | Mudança em conta Tiny | Reconciliação no cadastro de produto |
| Reserva expirou sem NF | Worker travou ou cancelamento não-rastreado | Auto-libera; pedido vai pra fila "reserva_expirada" pra investigação |
| Lock de localização > 1h | Operador esqueceu cycle count aberto | Alerta supervisor; admin pode forçar finalização |
| Bloqueio de localização órfão (`bloqueada_por`) | Operador abriu contagem e abandonou (fechou aba, perdeu conexão) | Cron 10min libera locks > 30min sem contagem nova |
| Operadores tentam pegar mesma localização simultaneamente | Race em `bloqueada_por` | UPDATE atômico; perdedor recebe alerta na UI e tenta próxima |
| Contagem duplo_blind diverge entre operadores | Erro humano ou má identificação de SKU | Sistema dispara 3ª contagem por supervisor; divergência fica `pendente` até resolução |
| Sessão completa iniciada com pedidos em andamento | Admin não esperou separação concluir | Sistema avisa antes de iniciar; pedidos já reservados ficam aguardando finalização da sessão |
| Sessão de inventário órfã (servidor caiu durante) | Crash de servidor ou rede | Cada contagem é INSERT atômico (nada perdido). Cron 4h detecta sessão `em_andamento` sem contagens nas últimas 4h; alerta supervisor pode "retomar" (reabrir) ou "encerrar" (libera locks, cancela sessão); auditoria registra a ação |
| Lançamento retroativo não reconciliado > 7 dias | Operador esqueceu de lançar NF, ou NF nunca chegou | Alerta no dashboard geral; após 14 dias, vira crítico (admin precisa marcar como "definitivo" ou "ajuste manual" pra investigação contábil) |
| Lead time do fornecedor desatualizado | `ultima_compra_em` > 6 meses | Alerta pra revisar cadastro; tempos antigos não refletem realidade atual do fornecedor |

## 13. Escopo v1 vs v2+

**v1:**
- Tudo até a Fase 4 da migração
- Telas listadas na Fase 0
- Webhooks, ledger com 4 dimensões, reservas com TTL, devoluções classificadas, transferências (inter e intra-galpão), ajustes, troca SKU, estorno
- Módulo robusto de inventário: cycle count rotativo + inventário completo multi-operador com realtime, blind count, duplo blind, re-contagem, workflow de aprovação por tolerância, métricas de acuracidade
- Cadastro de fornecedores com lead time
- Lançamento retroativo (entrada de emergência) com fluxo de reconciliação
- Dashboard geral de eventos críticos
- Sync de catálogo via Tiny (NCM, CEST, origem fiscal, imagem)
- Cargo `supervisor_logistica` (sem restrições aplicadas; roles entram em v1.x+)

**v2 (escopo posterior):**
- Marketplace sync (push de saldo SISO → Tiny → ML/Shopee)
- Auto-import de NF de entrada (descontinua a entrada manual)
- Kits (montagem/desmontagem)
- Múltiplos depósitos por galpão (subdivisão fiscal além de localização física)
- RMA pra fornecedor com tracking de SLA
- Custo médio histórico (snapshots mensais)
- Fechamento contábil mensal
- Lotes/serial numbers (se necessário pra rastreabilidade de recall)
- ABC analysis automatizada (sugestão de slotting)
- FIFO/FEFO no roteamento

## 14. Open questions e pontos pendentes

### 14.1 Open questions (a confirmar no plan/implementação)

1. **Volume mensal de devoluções** — se for muito alto (>50/mês), tela de classificação precisa de batch ops e search robusto.
2. **Custo médio em empréstimos** — quando vendedora vende usando estoque da credora, o custo da NF da vendedora deveria ser igual ao custo médio do estoque da credora. Mas isso é só pra contabilidade interna; NF tem o preço de venda. Confirmar com contador antes da Fase 3.
3. **Snapshot inicial** — Fase 0 vai bulk-load `getEstoque` do Tiny pra cada produto+empresa. Pode levar horas pra rodar. Aceitar e rodar 1x. Inventário físico real só na Fase 2.
4. **Auto-quitação de empréstimo na devolução** — quando devolução íntegra de venda-com-empréstimo volta, debita 1 da dívida. E se a dívida já foi negativa por empréstimo reverso? Tratar como crédito da credora (saldo líquido fica mais negativo, ela passa a dever pra outra parte).
5. **Política de geo-priority** — galpão home > cidade > estado é regra fixa. Mas e se home tem cobertura magra e galpão remoto tem fartura? Aceitar viés geográfico em v1; tunável em v2 com peso configurável.
6. **Limite máximo por produto em empréstimo** — campo `limite_max_por_produto` em `siso_emprestimo_regras` está modelado mas não há tela pra configurar nem checagem no roteamento. Habilitar em v1 ou v2?

### 14.2 Pontos pendentes (decisão posterior ao build inicial)

Funcionalidades reconhecidas como necessárias mas adiadas pra evitar inflar Fase 0. Implementadas em v1.x (após estabilização) ou v2:

1. **Separação parcial** — operador no picking encontra menos do que o sistema dizia ter. Hoje o fluxo não está formalizado: vai precisar UI específica pra registrar qty real encontrada, ajuste automático na quádrupla, re-roteamento (outra localização? outro galpão? empréstimo? cancela item?), e notificação ao cliente. **Importante:** vai aparecer cedo em produção (estoque mentiroso pré-saneamento). Workaround temporário: ajuste manual + cancelamento de item via fluxo existente.

2. **Avaria detectada fora de devolução** — operador no cycle count, replenishment ou separação encontra item quebrado. Hoje cai em `ajuste_manual` com motivo livre. Falta: taxonomia de motivos (caixa amassada / produto quebrado / lacre rompido / vencido), foto obrigatória (mobile), workflow de quarentena, limite de auto-baixa por valor (acima de R$ X exige aprovação).

3. **RMA outbound (devolução pra fornecedor)** — `nf_devolucao_fornecedor` existe como `origem_tipo` mas o workflow é só "operador clica". Falta: status da RMA (aguardando autorização, autorizada, enviada, recebida crédito), SLA do fornecedor, saldo financeiro a receber (crédito de mercadoria devolvida), reconciliação contra próxima compra. Em v1, registra mov manualmente; gestão de processo fica pra v1.x ou v2.

4. **Permissões granulares por cargo** — cargo `supervisor_logistica` está cadastrado em v1 mas sem restrições aplicadas. Em v1 qualquer cargo pode programar inventário, aprovar divergência, editar matriz de empréstimos. Aplicar restrições em v1.x quando o WMS estiver consolidado.

5. **Notificações push** — dashboard de eventos críticos só atualiza ao abrir a tela. Email/Slack/push notification opt-in fica pra v2.

## 15. Glossário

| Termo | Definição |
|---|---|
| **Dono fiscal** | Empresa que pagou a NF de entrada. Tem o estoque "no nome dela" mesmo que não esteja fisicamente em galpão dela. |
| **Galpão físico** | Local onde a unidade está fisicamente armazenada (CWB, SP, etc). |
| **Localização** | Endereço dentro do galpão (prateleira/posição), com tipo (picking, overstock, recebimento, expedição, quarentena). |
| **Empresa vendedora (V)** | Empresa que recebeu o pedido do marketplace e vai emitir NF pro cliente. |
| **Empresa credora (C)** | Empresa cuja NF de entrada cobriu aquela unidade. Quem "pagou" o estoque. |
| **Empresa devedora (D)** | Empresa que vendeu usando estoque que não é dela. Fica devendo C. |
| **Quádrupla** | (produto, empresa_dona, galpão, localização) — unidade mínima de estoque. |
| **Ledger** | `siso_movimentacoes` — log imutável de toda movimentação. |
| **Empréstimo** | Movimentação `tipo='S' origem='emprestimo'` em que `empresa_dona_id` ≠ `emprestimo_devedora_id`. |
| **Tracker puro** | Modelo de empréstimo sem quitação ativa. Saldo devedor é só visualização; quita por fluxo reverso. |
| **TTL de reserva** | Tempo de vida de uma reserva (default 48h). Após expirar, é liberada automaticamente. |
| **Cycle count** | Inventário rotativo por localização, com lock que isola a contagem do resto da operação. |
| **Inventário completo** | Sessão que cobre todas as localizações ativas de um galpão; multi-operador em paralelo; bloqueia operação. |
| **Sessão de inventário** | Unidade de orquestração; agrupa áreas, contagens e divergências; tem ciclo `planejada → em_andamento → revisao → aprovada → aplicada`. |
| **Área de inventário** | Divisão da sessão; cada operador é dono de uma área e cobre as localizações dela. |
| **Blind count** | Modo onde o operador conta sem ver o saldo esperado (antifraude). |
| **Duplo blind** | Dois operadores contam a mesma área independentemente; sistema só compara após ambos terminarem. |
| **Rodada de contagem** | Tentativa de contagem; rodada=1 é a primeira; 2+ são re-contagens em caso de divergência. |
| **Tolerância de divergência** | % ou qty mínima abaixo da qual o sistema aceita o ajuste sem aprovação manual. |
| **Acuracidade** | % de localizações sem divergência na contagem; medida por localização, operador e global. |
| **Replenishment** | Reposição interna ao galpão (overstock → picking) via transferência intra-galpão. |
| **Cobertura (em dias)** | Saldo disponível dividido pelo giro diário médio dos últimos 30 dias. |
| **Lead time** | Tempo entre OC e recebimento da mercadoria do fornecedor. Cadastrado em `siso_produto_fornecedores` (min/médio/max). |
| **Lançamento retroativo** | Entrada de emergência registrada quando mercadoria já chegou ao galpão mas a NF de entrada ainda não foi formalmente lançada. Reconciliada posteriormente com a `compra_manual`. |
| **Cross-docking implícito** | Padrão emergente do lançamento retroativo: mercadoria é recebida e expedida sem passar formalmente pelo estoque (a passagem é registrada no ledger, mas não há "armazenagem" intermediária). |
| **Putaway** | Decisão de onde guardar mercadoria recebida. Sistema sugere automaticamente; operador pode aceitar ou trocar. |
| **`supervisor_logistica`** | Cargo proposto pra ações sensíveis de WMS. Em v1 cadastrado mas sem restrições aplicadas; em v1.x+ aplicar policies. |
| **Split shipment** | Envio dividido em múltiplas remessas/galpões. **Não suportado em v1** — pedido que exigiria split vai pra OC. |

---

**Fim do design.** Revisão técnica de logística (v2) + módulo robusto de inventário multi-operador realtime (v3) + auditoria fresh-eyes incorporada (v4). Próximo passo: invocar a skill `writing-plans` pra gerar plano de implementação task-by-task.
