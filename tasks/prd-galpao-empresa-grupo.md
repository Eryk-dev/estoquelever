# PRD: Estrutura Galpao / Empresa / Grupo

## 1. Introduction / Overview

O SISO atualmente trata cada filial (CWB, SP) como uma entidade monolitica: 1 filial = 1 empresa = 1 conta Tiny = 1 deposito. Na realidade, um galpao fisico pode abrigar multiplas empresas (CNPJs), e nem todas sao relevantes entre si (ex: autopecas vs utilidades).

Esta feature reestrutura o modelo de dados para refletir a hierarquia real: **Galpao > Empresa > Grupo**, permitindo N empresas por galpao, agrupamento por afinidade de negocio, e prioridade configuravel (tierlist) para deducao de estoque.

A visao do operador **nao muda** — ele continua vendo estoque agregado por galpao. A complexidade fica sob o capot: o webhook processor consulta estoque em todas as empresas do grupo, agrega por galpao para o operador, e o worker deduz seguindo o tier.

**Contexto atual:** 2 galpoes (CWB, SP) com 3+ empresas ja operando.

---

## 2. Goals

- Permitir N galpoes, cada um com N empresas (contas Tiny com CNPJ proprio)
- Agrupar empresas por afinidade (ex: "Autopecas") para que so se consultem entre si
- Manter visao do operador inalterada (estoque por galpao, nao por empresa)
- Admin configura prioridade (tier) de atendimento por empresa dentro do grupo
- Empresa que recebeu o pedido e sempre tier 1 automaticamente
- Worker deduz estoque seguindo o tier: primeiro a empresa que recebeu, depois as do mesmo galpao pelo tier, depois outros galpoes
- Migrar dados existentes (NetAir/CWB, NetParts/SP) sem downtime nem perda de historico
- Rate limiting por empresa (conta Tiny), nao mais por "filial"

---

## 3. User Stories

### US-001: Admin cria/edita galpoes
**Description:** As an admin, I want to create and manage warehouses (galpoes) so that I can represent the physical locations where stock is stored.

**Acceptance Criteria:**
- [ ] Na tela de Configuracoes, existe uma secao "Galpoes e Empresas"
- [ ] Admin pode criar um galpao com: nome (ex: "CWB"), descricao opcional, ativo (boolean)
- [ ] Admin pode editar nome, descricao e desativar um galpao
- [ ] Galpao desativado nao aparece em consultas de estoque
- [ ] Galpoes existentes (CWB, SP) sao criados automaticamente pela migracao

### US-002: Admin vincula empresas a galpoes
**Description:** As an admin, I want to assign companies (Tiny ERP accounts) to warehouses so that the system knows which companies operate in each physical location.

**Acceptance Criteria:**
- [ ] Cada empresa tem: nome, CNPJ, galpao (FK), ativa (boolean)
- [ ] A conexao Tiny (OAuth2, deposito) continua vinculada a empresa (nao mais a "filial")
- [ ] O card de conexao Tiny na tela de Configuracoes agora mostra a empresa e seu galpao
- [ ] Admin pode mover uma empresa entre galpoes (editar FK de galpao)
- [ ] Empresas existentes (NetAir, NetParts) sao vinculadas automaticamente pela migracao

### US-003: Admin cria/edita grupos de empresas
**Description:** As an admin, I want to create groups of companies that can fulfill each other's orders, so that unrelated businesses (e.g., utilities) are excluded from stock checks.

**Acceptance Criteria:**
- [ ] Admin pode criar um grupo com: nome (ex: "Autopecas"), descricao opcional
- [ ] Admin pode adicionar/remover empresas de um grupo
- [ ] Uma empresa pode pertencer a apenas um grupo (constraint unique)
- [ ] Empresa sem grupo nao sera consultada como suporte para nenhum pedido
- [ ] Grupo "Autopecas" com NetAir e NetParts e criado pela migracao

### US-004: Admin configura tier de prioridade
**Description:** As an admin, I want to set the priority order for stock deduction within a group, so that the system knows which company to deduct from first when multiple have stock.

**Acceptance Criteria:**
- [ ] Cada relacao empresa-grupo tem um campo `tier` (integer, default 1)
- [ ] Admin pode reordenar o tier via UI (drag ou input numerico)
- [ ] Tier mais baixo = maior prioridade (1 = primeiro a ser consultado)
- [ ] A empresa que recebeu o pedido e SEMPRE tier 1 automaticamente (override no runtime, nao no banco)
- [ ] Empate de tier = ordem alfabetica de nome da empresa (deterministic)

### US-005: Webhook identifica empresa por CNPJ
**Description:** As a system, I need to identify which company (not just branch) sent the webhook, so that I can process the order in the correct context.

**Acceptance Criteria:**
- [ ] `cnpj-filial.ts` e substituido por lookup na tabela `siso_empresas` (CNPJ -> empresa_id -> galpao_id -> grupo_id)
- [ ] Se o CNPJ nao pertence a nenhuma empresa ativa, retorna 400 (mesmo comportamento atual)
- [ ] O webhook log agora armazena `empresa_id` em vez de `filial`
- [ ] `siso_pedidos.filial_origem` e substituido por `empresa_origem_id` (FK para siso_empresas)
- [ ] Campos derivados `galpao_origem` e `grupo_id` sao resolvidos via JOIN (nao duplicados)

### US-006: Processor consulta estoque em todas empresas do grupo
**Description:** As a system, I need to check stock across all companies in the same group, so that the suggestion considers all available stock.

**Acceptance Criteria:**
- [ ] Dado um pedido da Empresa A (grupo G), o processor busca tokens OAuth2 de todas empresas ativas do grupo G
- [ ] Para cada item, consulta estoque em cada empresa do grupo (respeitando rate limit por empresa)
- [ ] Estoque e agregado por galpao para calculo de sugestao (operador ve "CWB 8 | SP 3", nao "NetAir 5 | Empresa X 3 | NetParts 3")
- [ ] `siso_pedido_itens` armazena estoque por empresa (nao por galpao) — a agregacao e feita no frontend/processor
- [ ] Se uma empresa do grupo nao tem token valido, o estoque dela e 0 + warning no motivo

### US-007: Sugestao calculada por galpao (visao operador inalterada)
**Description:** As an operator, I want to see stock aggregated by warehouse, not by company, because I only care about physical availability in my location.

**Acceptance Criteria:**
- [ ] O PedidoCard continua mostrando "CWB X | SP Y" (nomes de galpao)
- [ ] Os valores sao a soma de todas empresas daquele galpao dentro do grupo
- [ ] A logica de sugestao (propria/transferencia/oc) usa os agregados por galpao
- [ ] Auto-aprovacao: galpao de origem cobre tudo (soma das empresas de origem no grupo)
- [ ] O motivo da sugestao mostra galpao, nao empresa

### US-008: Worker deduz estoque seguindo tier
**Description:** As a system, I need to deduct stock from companies following the tier priority, so that the correct Tiny account is debited.

**Acceptance Criteria:**
- [ ] `siso_fila_execucao` agora armazena `empresa_id` em vez de `filial_execucao`
- [ ] Decisao "propria": worker tenta deduzir de cada empresa do galpao de origem, na ordem do tier (empresa que recebeu = tier 1 override)
- [ ] Se empresa tier 1 nao cobre tudo: deduz o que tem, passa o restante pra tier 2
- [ ] Decisao "transferencia": deduz item-a-item do galpao suporte, seguindo tier das empresas la
- [ ] Decisao "oc": sem alteracao (nao deduz estoque)
- [ ] `siso_pedido_itens.estoque_saida_lancada` continua funcionando para idempotencia
- [ ] Novo campo: `siso_pedido_itens.empresa_deducao_id` registra de qual empresa o estoque foi deduzido
- [ ] Rate limiting agora e por empresa (cada conta Tiny = 55 req/min)

### US-009: Migracao sem downtime
**Description:** As a system, I need to migrate existing data to the new structure without losing history or requiring downtime.

**Acceptance Criteria:**
- [ ] Migration SQL cria tabelas novas (`siso_galpoes`, `siso_empresas`, `siso_grupos`, `siso_grupo_empresas`)
- [ ] Migration cria galpoes CWB e SP automaticamente
- [ ] Migration cria empresas NetAir (CWB) e NetParts (SP) com CNPJs corretos
- [ ] Migration cria grupo "Autopecas" com ambas empresas, tier 1
- [ ] Migration migra `siso_tiny_connections.filial` para apontar para `siso_empresas.id`
- [ ] Migration migra `siso_pedidos.filial_origem` para `empresa_origem_id`
- [ ] Migration migra `siso_fila_execucao.filial_execucao` para `empresa_id`
- [ ] Migration migra `siso_webhook_logs.filial` para `empresa_id`
- [ ] Migration migra `siso_api_calls.filial` para `empresa_id`
- [ ] Colunas antigas mantidas temporariamente (deprecated) para rollback seguro
- [ ] Pedidos historicos mantem dados corretos apos migracao

---

## 4. Functional Requirements

### Banco de dados

**FR-01:** Criar tabela `siso_galpoes` com campos: `id` (uuid PK), `nome` (text unique not null), `descricao` (text), `ativo` (boolean default true), `criado_em`, `atualizado_em`.

**FR-02:** Criar tabela `siso_empresas` com campos: `id` (uuid PK), `nome` (text not null), `cnpj` (text unique not null), `galpao_id` (uuid FK siso_galpoes not null), `ativo` (boolean default true), `criado_em`, `atualizado_em`.

**FR-03:** Criar tabela `siso_grupos` com campos: `id` (uuid PK), `nome` (text unique not null), `descricao` (text), `criado_em`, `atualizado_em`.

**FR-04:** Criar tabela `siso_grupo_empresas` com campos: `id` (uuid PK), `grupo_id` (uuid FK siso_grupos), `empresa_id` (uuid FK siso_empresas unique), `tier` (integer default 1, check > 0), `criado_em`. Constraint unique em `empresa_id` (empresa pertence a no maximo 1 grupo).

**FR-05:** Adicionar coluna `empresa_id` (uuid FK siso_empresas) em `siso_tiny_connections`. Migrar dados existentes: CWB -> empresa NetAir, SP -> empresa NetParts. Manter `filial` temporariamente.

**FR-06:** Adicionar coluna `empresa_origem_id` (uuid FK siso_empresas) em `siso_pedidos`. Migrar dados existentes via CNPJ lookup. Manter `filial_origem` temporariamente.

**FR-07:** Adicionar coluna `empresa_id` (uuid FK siso_empresas) em `siso_fila_execucao`. Migrar `filial_execucao` via lookup. Manter coluna antiga temporariamente. Remover constraint `chk_fila_filial` (nao sera mais CWB/SP hardcoded).

**FR-08:** Adicionar coluna `empresa_id` (uuid FK siso_empresas) em `siso_webhook_logs`. Migrar `filial`. Manter temporariamente.

**FR-09:** Alterar `siso_api_calls` para usar `empresa_id` (uuid FK siso_empresas) em vez de `filial` (text). Rate limiting passa a ser por empresa.

**FR-10:** Adicionar coluna `empresa_deducao_id` (uuid FK siso_empresas, nullable) em `siso_pedido_itens` para registrar de qual empresa cada item teve estoque deduzido.

**FR-11:** Adicionar colunas em `siso_pedido_itens` para armazenar estoque por empresa (array JSON ou tabela normalizada `siso_pedido_item_estoques` com: `pedido_id`, `produto_id`, `empresa_id`, `deposito_id`, `deposito_nome`, `saldo`, `reservado`, `disponivel`). Decisao de design: usar tabela normalizada para queries eficientes.

### Backend

**FR-12:** Substituir `cnpj-filial.ts` por um modulo `empresa-lookup.ts` que faz query em `siso_empresas` por CNPJ e retorna `{ empresaId, galpaoId, grupoId, nome, galpaoNome }`. Cachear em memoria com TTL de 5 min (nao muda frequentemente).

**FR-13:** Criar modulo `grupo-resolver.ts` com funcoes:
- `getEmpresasDoGrupo(grupoId)` — retorna empresas ativas do grupo com tier
- `getEmpresasPorGalpao(grupoId, galpaoId)` — retorna empresas ativas do grupo naquele galpao
- `getOrdemDeducao(grupoId, empresaOrigemId)` — retorna lista ordenada: empresa origem primeiro, depois por tier, depois por galpao

**FR-14:** Alterar `webhook-processor.ts` para:
- Receber `empresaId` em vez de `filial`
- Resolver grupo via `empresa-lookup.ts`
- Buscar tokens de TODAS empresas ativas do grupo
- Enriquecer estoque item a item em cada empresa do grupo
- Agregar por galpao para calculo de sugestao
- Armazenar estoque detalhado por empresa na tabela normalizada

**FR-15:** Alterar `calcularSugestao()` para trabalhar com dados agregados por galpao em vez de "CWB/SP" hardcoded. Parametros: `galpaoOrigemId`, `estoquesPorGalpao: Map<galpaoId, { atende: boolean, disponivel: number }>`.

**FR-16:** Alterar `execution-worker.ts` para:
- Resolver a lista ordenada de deducao via `getOrdemDeducao()`
- Para cada item, percorrer empresas na ordem ate cobrir a quantidade pedida
- Se empresa tier 1 tem 3 de 5 necessarios: deduz 3 ali, passa 2 pra proxima
- Registrar `empresa_deducao_id` em cada `siso_pedido_itens`
- Rate limit por empresa (nao por galpao)

**FR-17:** Alterar `rate-limiter.ts` para usar `empresa_id` em vez de `filial`. `waitForRateLimit(empresaId)`, `registerApiCall(empresaId, endpoint)`, `checkRateLimit(empresaId)`.

**FR-18:** Alterar `tiny-oauth.ts` > `getValidTokenByFilial()` para `getValidTokenByEmpresa(empresaId)`. Busca token na `siso_tiny_connections` pela `empresa_id`.

**FR-19:** Alterar `/api/webhook/tiny/route.ts` para usar `empresa-lookup.ts` em vez de `getFilialByCnpj()`. Passar `empresaId` ao `processWebhook()`.

**FR-20:** Alterar `/api/pedidos/aprovar/route.ts` para resolver empresa e galpao a partir do pedido, e enfileirar com `empresa_id`.

**FR-21:** Criar endpoints de API para CRUD:
- `GET/POST /api/admin/galpoes` — listar/criar galpoes
- `PUT /api/admin/galpoes/[id]` — editar galpao
- `GET/POST /api/admin/empresas` — listar/criar empresas
- `PUT /api/admin/empresas/[id]` — editar empresa (incluindo mover de galpao)
- `GET/POST /api/admin/grupos` — listar/criar grupos
- `PUT /api/admin/grupos/[id]` — editar grupo
- `POST /api/admin/grupos/[id]/empresas` — adicionar empresa ao grupo (com tier)
- `DELETE /api/admin/grupos/[id]/empresas/[empresaId]` — remover empresa do grupo
- `PUT /api/admin/grupos/[id]/empresas/[empresaId]` — alterar tier

### Frontend

**FR-22:** Na tela de Configuracoes, adicionar secao "Galpoes e Empresas" acima das conexoes Tiny. Layout hierarquico:
```
Galpao CWB
  ├── NetAir [Autopecas, Tier 1] [Conexao Tiny: Conectado]
  ├── Empresa X [Autopecas, Tier 2] [Conexao Tiny: Nao configurado]
  └── + Adicionar empresa

Galpao SP
  └── NetParts [Autopecas, Tier 1] [Conexao Tiny: Conectado]

+ Adicionar galpao
```

**FR-23:** Mover os ConnectionCards para dentro da hierarquia de empresas (empresa expande e mostra sua conexao Tiny + deposito, como hoje, mas aninhado).

**FR-24:** Adicionar UI para gerenciar grupos. Tela simples: lista de grupos, cada grupo mostra suas empresas com tier editavel.

**FR-25:** No Dashboard (PedidoCard), continuar mostrando nomes de galpao. Substituir "CWB"/"SP" hardcoded por lookup do nome do galpao. StockPill mostra o valor agregado.

**FR-26:** Alterar `filtrar-pedidos.ts` para filtrar por galpao da empresa do operador (em vez de "filial_origem === 'CWB'"). O cargo `operador_cwb` sera vinculado ao galpao CWB, nao a string "CWB".

**FR-27:** Tipo `Filial` em `types/index.ts` sera substituido por `galpaoId: string` (UUID). Os tipos `Pedido`, `EstoqueItem` atualizados para usar IDs em vez de "CWB"/"SP".

---

## 5. Non-Goals (Out of Scope)

- **SKU equivalentes / intercambiaveis:** mapeamento de SKUs alternativos sera uma feature futura separada.
- **Dashboard em tempo real:** o dashboard continua com dados mock nesta fase. A substituicao por Supabase realtime sera feita separadamente.
- **Mudanca de cargos de usuario:** os cargos `operador_cwb` e `operador_sp` continuam existindo por nome. Uma evolucao futura pode vincular cargo a galpao_id dinamicamente.
- **Multi-deposito por empresa:** cada empresa continua tendo 1 deposito selecionado. Suporte a N depositos por empresa e futuro.
- **UI mobile-specific:** a tela de galpoes/empresas/grupos segue o padrao existente (max-w-3xl, mobile-first).

---

## 6. Technical Considerations

### 6.1 Migracao de dados

A migracao e a parte mais critica. Estrategia:

1. Criar tabelas novas (`siso_galpoes`, `siso_empresas`, `siso_grupos`, `siso_grupo_empresas`)
2. Seed com dados existentes (CWB, SP, NetAir, NetParts, grupo Autopecas)
3. Adicionar colunas `empresa_id` nas tabelas existentes (nullable inicialmente)
4. Preencher `empresa_id` via SQL baseado nos valores de `filial`/`cnpj` existentes
5. Atualizar codigo para usar `empresa_id` como primary
6. Em migracao futura: tornar `empresa_id` NOT NULL e dropar colunas `filial` antigas

### 6.2 Performance

- Cache de CNPJ -> empresa em memoria (Map com TTL 5min) para evitar query por webhook
- Cache de grupo -> empresas (mesmo TTL)
- Estoque enriquecido agora consulta N empresas em vez de 2 — mais API calls por pedido
- Rate limit por empresa garante que nao excedemos 55 req/min por conta Tiny
- Para 500 pedidos/dia com 3 empresas no grupo: ~3x mais API calls. Monitorar impacto.

### 6.3 Compatibilidade

- `cnpj-filial.ts` sera mantido como wrapper deprecado que chama `empresa-lookup.ts` internamente (facilita rollback)
- Colunas `filial` antigas mantidas por 2 sprints antes de serem removidas
- Frontend nao muda visualmente — apenas os dados internos mudam de "CWB"/"SP" para UUIDs que resolvem para nomes de galpao

### 6.4 Ordem de implementacao sugerida

A implementacao deve seguir esta ordem para minimizar risco:

```
Fase 1 — Banco (sem quebrar nada)
  1. Migration: criar siso_galpoes, siso_empresas, siso_grupos, siso_grupo_empresas
  2. Migration: seed CWB, SP, NetAir, NetParts, grupo Autopecas
  3. Migration: adicionar empresa_id (nullable) em todas tabelas existentes
  4. Migration: preencher empresa_id com base em filial/cnpj

Fase 2 — Backend (mudancas internas, mesma interface)
  5. Criar empresa-lookup.ts + grupo-resolver.ts
  6. Alterar tiny-oauth.ts (getValidTokenByEmpresa)
  7. Alterar rate-limiter.ts (empresa_id)
  8. Alterar webhook-processor.ts (multi-empresa)
  9. Alterar execution-worker.ts (tier-based deduction)
  10. Alterar route handlers (webhook, aprovar)

Fase 3 — API Admin
  11. Criar endpoints CRUD galpoes/empresas/grupos

Fase 4 — Frontend
  12. Secao Galpoes e Empresas na tela de Configuracoes
  13. UI de grupos e tier
  14. Atualizar types/index.ts
  15. Atualizar PedidoCard (galpao names via lookup)
  16. Atualizar filtrar-pedidos.ts

Fase 5 — Cleanup
  17. Remover cnpj-filial.ts (apos confirmar estabilidade)
  18. Migration: dropar colunas filial antigas
  19. Remover constraints hardcoded (chk_fila_filial etc)
```

---

## 7. Success Metrics

- Webhook processing continua funcionando sem regressao (0 erros novos)
- Admin consegue criar novo galpao + empresa + grupo e um pedido dessa empresa e processado corretamente
- Estoque agregado por galpao no dashboard corresponde a soma real das empresas
- Worker deduz na ordem correta do tier (verificavel nos logs)
- Tempo medio de processamento de webhook nao degrada mais de 30% (mais API calls)
- Migracao zero-downtime: nenhum pedido perdido durante deploy

---

## 8. Open Questions

1. **Nomenclatura de cargos:** `operador_cwb` e `operador_sp` sao hardcoded. Na fase atual, manter assim e mapear "cwb" -> galpao CWB por convenncao? Ou ja criar uma tabela `siso_usuario_galpao` vinculando operador a galpao?

2. **Admin pode adicionar nova empresa pelo UI, ou a criacao da conta Tiny (CNPJ) e feita manualmente e o sistema so vincula?** (Assumido: admin cria empresa no SISO e depois configura OAuth2 nela.)

3. **Se uma empresa sai de um grupo, pedidos antigos dela no historico ficam como?** (Assumido: mantidos, grupo_id no pedido e snapshot do momento do processamento.)

4. **Tier e por grupo globalmente ou por galpao dentro do grupo?** Exemplo: no grupo Autopecas, Empresa X (CWB) pode ter tier 2 global, mas quando o pedido e de CWB ela seria tier 2 la e tier 3 se o pedido for de SP? (Assumido: tier global no grupo. A logica de "mesmo galpao primeiro" e feita no runtime pelo `getOrdemDeducao()`.)

5. **Volume de empresas esperado?** Se forem 10+ empresas por grupo, o enriquecimento de estoque vai ser lento (N x items x 2 API calls). Pode ser necessario paralelizar consultas (Promise.allSettled com rate limit). (Assumido: comeca sequencial, otimiza se necessario.)
