# SISO - Escopo Definitivo
## Sistema Inteligente de Separacao de Ordens v2

---

## 1. RESUMO EXECUTIVO

Aplicacao web que substitui o workflow n8n de processamento de pedidos multi-filial.

**Dois modos de operacao:**
- **Automatico**: Pedidos simples (filial de origem tem tudo) sao processados sem intervencao humana
- **Aprovacao manual**: Pedidos que precisam de transferencia entre filiais passam pela aprovacao do gestor do galpao

**Numeros:**
- ~500 pedidos/dia
- 2 filiais: CWB (NetAir) e SP (NetParts)
- Operadores usam PC (desktop-first)
- Prioridade e assertividade, nao velocidade

---

## 2. REGRA DE DECISAO PRINCIPAL

```
PEDIDO CHEGA (webhook Tiny)
  │
  ├─ Filial de origem tem TODOS os itens?
  │   SIM → AUTO-APROVAR → Executar imediatamente
  │   NAO ↓
  │
  ├─ Filial suporte tem TODOS os itens?
  │   SIM → FILA DE APROVACAO (transferencia precisa de aval humano)
  │   NAO ↓
  │
  ├─ Nenhuma filial tem tudo?
  │   → FILA DE APROVACAO (operador decide)
  │   → Sugestao: filial do fornecedor do item mais caro
  │
  └─ Estoque parcial (CWB tem uns, SP tem outros)?
      → FILA DE APROVACAO (operador decide entre as opcoes)
```

### Regra critica: O que passa pelo painel e o que nao passa

| Cenario | Acao | Painel? |
|---------|------|---------|
| Origem tem 100% dos itens | Auto-aprovar | NAO |
| Suporte tem 100% dos itens | Aprovacao humana | SIM |
| Nenhuma tem tudo, mas juntas tem | Aprovacao humana | SIM |
| Nenhuma filial tem nada | Aprovacao humana | SIM |

**A unica situacao que nao precisa de humano e quando a filial de origem resolve sozinha.**

### Estimativa de volume no painel:
- 500 pedidos/dia total
- Se ~70% sao resolvidos pela origem → ~150 pedidos/dia no painel
- Se ~50% sao resolvidos pela origem → ~250 pedidos/dia no painel
- O operador lida com a fila ao longo do dia, sem SLA rigido

---

## 3. FLUXO DETALHADO

### FASE 1: Ingestao (100% automatica)

```
1. Tiny ERP envia webhook POST "atualizacao_pedido" + "aprovado"
2. Backend recebe, identifica filial pelo CNPJ:
   - 34857388000163 → CWB (conta Tiny NetAir)
   - 34857388000244 → SP (conta Tiny NetParts)
3. Consulta detalhes do pedido na API Tiny (itens, cliente, ecommerce)
4. Para CADA ITEM do pedido:
   a. Consulta estoque na filial de ORIGEM (API da propria conta)
   b. Busca o produto na filial SUPORTE pelo SKU
   c. Consulta estoque na filial SUPORTE
   d. Identifica fornecedor pelo SKU (tabela de regras)
5. Classifica o pedido:
   - todos_itens_origem: boolean (origem tem estoque pra tudo?)
   - todos_itens_suporte: boolean (suporte tem estoque pra tudo?)
   - itens_sem_estoque: lista de itens que ninguem tem
6. Calcula sugestao:
   - Se todos_itens_origem → "propria_filial" (auto-aprovar)
   - Se todos_itens_suporte → "filial_suporte"
   - Se parcial → filial do fornecedor do item MAIS CARO sem estoque
   - Se nenhuma → filial do fornecedor do item MAIS CARO
7. Salva no Supabase
```

### FASE 2A: Auto-aprovacao (filial de origem tem tudo)

```
8a. Status = "auto_aprovado"
9a. Executa imediatamente:
    - Inserir marcador da filial (ex: "CWB")
    - Gerar nota fiscal
    - Notificar Slack
10a. Status = "concluido"
```

O operador NAO ve esses pedidos na fila. Aparecem apenas no historico.

### FASE 2B: Fila de aprovacao (precisa de humano)

```
8b. Status = "pendente"
9b. Aparece no painel do operador da filial de origem
10b. Operador ve:
    - Dados do pedido
    - Tabela de itens com estoque de ambas filiais
    - Quais itens tem e quais faltam em cada filial
    - Sugestao do sistema pre-selecionada
11b. Operador escolhe uma das opcoes:
    - Atender pela propria filial (CWB/SP)
    - Transferir para filial suporte
    - Ordem de compra
12b. Clica "Aprovar"
```

### FASE 3: Execucao (apos aprovacao manual ou auto)

Conforme a decisao:

**OPCAO A - Propria filial atende:**
```
1. Inserir marcador da filial no pedido Tiny
2. Gerar NF via API Tiny
3. Notificar Slack
```

**OPCAO B - Filial suporte atende (transferencia):**
```
1. Inserir marcador da filial suporte no pedido Tiny
2. Gerar NF na filial ORIGINAL (questao fiscal - CNPJ do pedido)
3. Estornar estoque na filial original (entrada "E")
   → "Estorno pedido {numero}, Atendido por {filial_suporte}"
4. Baixar estoque na filial suporte (saida "S")
   → "Saida para atender pedido {numero}, {filial_origem}"
5. Notificar Slack: "ATENDIDO PELA FILIAL {X}"
```

**OPCAO C - Ordem de compra:**
```
1. Inserir marcadores de OC baseados no SKU (fornecedor + filial proxima)
2. Gerar NF na filial de origem
3. Registrar OC no banco
4. Notificar Slack: "ORDEM DE COMPRA - {fornecedor}"
```

**Para itens sem estoque dentro de opcao B:**
Quando operador escolhe "Transferir para SP" mas SP so tem 2 de 3 itens:
- Os 2 itens com estoque: transferencia normal
- O item sem estoque: marcador de OC para aquele item especifico

---

## 4. USUARIOS E AUTENTICACAO

| Papel | Permissao | Ve no painel |
|-------|-----------|-------------|
| Operador CWB | Aprovar pedidos que entraram na NetAir | Fila CWB pendente + historico CWB |
| Operador SP | Aprovar pedidos que entraram na NetParts | Fila SP pendente + historico SP |
| Admin | Tudo | Ambas filas + metricas + configuracoes |

- Login: email + senha (Supabase Auth)
- Multiplos operadores por filial: SIM
- Concorrencia: lock otimista (ao clicar "Aprovar", se outro ja aprovou, mostra aviso e remove da fila)
- Sem notificacao sonora/push (operador monitora a tela ativamente)

---

## 5. TELA PRINCIPAL: FILA DE PEDIDOS

### Principio de design
- Desktop-first (PC)
- "Caixa de entrada" - olhar, decidir, proximo
- Informacao densa mas clara
- Zero cliques desnecessarios
- Um radio button + um botao por pedido

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  SISO                                                                │
│  ┌────────┐ ┌────────────┐ ┌───────────┐                            │
│  │Pendente│ │ Concluidos │ │ Auto (hoje)│          Eryk · CWB  [Sair]│
│  │  12    │ │    138     │ │    350     │                            │
│  └────────┘ └────────────┘ └───────────┘                            │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #90892 · ML · Leonardo Silva · 26/06 · Mercado Envios         │  │
│  │                                                                │  │
│  │  Produto                          Qtd  Valor    CWB    SP     │  │
│  │  ──────────────────────────────── ───  ──────  ─────  ─────   │  │
│  │  SERVO MOTOR CXA VW (019982)       1  R$104      15      8   │  │
│  │  BOBINA IGNICAO GOL (LD4021)       2  R$ 87       0     12   │  │
│  │                                                                │  │
│  │  CWB: 1/2 itens · SP: 2/2 itens                               │  │
│  │                                                                │  │
│  │  (○) CWB        (●) Transferir SP        (○) Ordem de Compra  │  │
│  │  [1 item sem     [✓ SP tem tudo]          [OC para 2 itens]   │  │
│  │   estoque CWB]                                                 │  │
│  │                                                                │  │
│  │                                           [ Aprovar → ]        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #90894 · ML · Joao Pedro · 26/06 · Correios                   │  │
│  │                                                                │  │
│  │  Produto                          Qtd  Valor    CWB    SP     │  │
│  │  ──────────────────────────────── ───  ──────  ─────  ─────   │  │
│  │  SENSOR TEMP AGUA (G1025)          1  R$210      20      5   │  │
│  │  MODULO ECU FLEX (X9876)           1  R$ 45       0      0   │  │
│  │  BOBINA IGNICAO (LD4021)           1  R$ 87       0     12   │  │
│  │                                                                │  │
│  │  CWB: 1/3 itens · SP: 2/3 itens · Sem estoque: 1 item        │  │
│  │                                                                │  │
│  │  (○) CWB        (○) SP                  (●) Ordem de Compra   │  │
│  │  [falta 2 itens] [falta 1 item]          [Forn: GAUSS (CWB)] │  │
│  │                                           Item +caro: G1025   │  │
│  │                                                                │  │
│  │                                           [ Aprovar → ]        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #90895 · Shopee · Maria · 26/06 · Loggi                       │  │
│  │                                                                │  │
│  │  ESTOQUE PARCIAL - Nenhuma filial tem tudo, mas juntas tem     │  │
│  │                                                                │  │
│  │  Produto                          Qtd  Valor    CWB    SP     │  │
│  │  ──────────────────────────────── ───  ──────  ─────  ─────   │  │
│  │  SENSOR TEMP AGUA (G1025)          1  R$210      20      0   │  │
│  │  BOBINA IGNICAO (LD4021)           2  R$ 87       0     12   │  │
│  │                                                                │  │
│  │  CWB: 1/2 · SP: 1/2 · Juntas: 2/2                             │  │
│  │                                                                │  │
│  │  (○) CWB         (○) SP                (○) Ordem de Compra    │  │
│  │  [tem G1025       [tem LD4021           [OC completa]          │  │
│  │   falta LD4021]    falta G1025]                                │  │
│  │                                                                │  │
│  │  ⚠ Operador: escolha a filial que vai consolidar o envio.     │  │
│  │    Itens faltantes serao transferidos ou entram em OC.         │  │
│  │                                                                │  │
│  │                                           [ Aprovar → ]        │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### Aba "Concluidos"
- Mesmos cards, mas com badge: "Auto", "CWB", "SP", "OC"
- Mostra quem aprovou e quando
- Busca por numero do pedido
- Filtro por data

### Aba "Auto (hoje)"
- Pedidos auto-aprovados do dia
- Apenas visualizacao (sem acao)
- Serve pra conferencia rapida

### Comportamento
- Pedidos ordenados por data (mais antigo primeiro)
- Ao aprovar: card some com animacao
- Se outro operador aprova: card some via Realtime
- Sugestao do sistema vem pre-selecionada no radio
- Informacao contextual abaixo de cada opcao (o que acontece se escolher)

---

## 6. MODELO DE DADOS

### pedidos
```sql
CREATE TABLE pedidos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tiny_pedido_id      BIGINT NOT NULL UNIQUE,
  numero_pedido       VARCHAR NOT NULL,
  filial_origem       VARCHAR NOT NULL CHECK (filial_origem IN ('CWB','SP')),
  cnpj                VARCHAR NOT NULL,

  -- Status do pedido
  status              VARCHAR NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','aprovado','executando','concluido','erro')),
  modo                VARCHAR NOT NULL DEFAULT 'manual'
    CHECK (modo IN ('auto','manual')),

  -- Decisao
  decisao             VARCHAR
    CHECK (decisao IN ('propria_filial','filial_suporte','ordem_compra')),
  sugestao_sistema    VARCHAR
    CHECK (sugestao_sistema IN ('propria_filial','filial_suporte','ordem_compra')),
  filial_atendimento  VARCHAR CHECK (filial_atendimento IN ('CWB','SP')),

  -- Classificacao de estoque
  todos_itens_origem  BOOLEAN NOT NULL DEFAULT FALSE,
  todos_itens_suporte BOOLEAN NOT NULL DEFAULT FALSE,
  tem_parcial         BOOLEAN NOT NULL DEFAULT FALSE,

  -- Dados do pedido
  cliente_nome        VARCHAR,
  cliente_documento   VARCHAR,
  ecommerce           VARCHAR,
  forma_envio         VARCHAR,
  id_pedido_ecommerce VARCHAR,
  data_pedido         DATE,
  valor_total         DECIMAL(10,2),

  -- Aprovacao
  aprovado_por        UUID REFERENCES auth.users(id),
  aprovado_em         TIMESTAMPTZ,
  observacao          TEXT,

  -- Meta
  webhook_raw         JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pedidos_status ON pedidos(status);
CREATE INDEX idx_pedidos_filial_status ON pedidos(filial_origem, status);
CREATE INDEX idx_pedidos_created ON pedidos(created_at DESC);
```

### pedido_itens
```sql
CREATE TABLE pedido_itens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id           UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_descricao   VARCHAR NOT NULL,
  produto_sku         VARCHAR NOT NULL,
  produto_id_origem   BIGINT,
  produto_id_suporte  BIGINT,
  quantidade          INTEGER NOT NULL,
  valor_unitario      DECIMAL(10,2) NOT NULL,
  estoque_origem      INTEGER,
  estoque_suporte     INTEGER,
  deposito_id_origem  BIGINT,
  deposito_id_suporte BIGINT,
  tem_estoque_origem  BOOLEAN NOT NULL DEFAULT FALSE,
  tem_estoque_suporte BOOLEAN NOT NULL DEFAULT FALSE,
  fornecedor          VARCHAR,
  filial_fornecedor   VARCHAR CHECK (filial_fornecedor IN ('CWB','SP')),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_itens_pedido ON pedido_itens(pedido_id);
```

### execucoes
```sql
CREATE TABLE execucoes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id           UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  etapa               VARCHAR NOT NULL
    CHECK (etapa IN ('marcador','nota_fiscal','estorno_estoque','saida_estoque','slack','marcador_oc')),
  ordem               INTEGER NOT NULL,
  status              VARCHAR NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','executando','sucesso','erro')),
  tentativas          INTEGER DEFAULT 0,
  max_tentativas      INTEGER DEFAULT 3,
  detalhes            JSONB,
  erro                TEXT,
  executado_em        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_exec_pedido ON execucoes(pedido_id);
CREATE INDEX idx_exec_status ON execucoes(status) WHERE status IN ('pendente','erro');
```

### perfis
```sql
CREATE TABLE perfis (
  id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome                VARCHAR NOT NULL,
  filial              VARCHAR NOT NULL CHECK (filial IN ('CWB','SP','ADMIN')),
  ativo               BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
```

### fornecedores
```sql
CREATE TABLE fornecedores (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regra_tipo          VARCHAR NOT NULL CHECK (regra_tipo IN ('prefixo','tamanho_exato')),
  regra_valor         VARCHAR NOT NULL,
  nome                VARCHAR NOT NULL,
  filial_proxima      VARCHAR NOT NULL CHECK (filial_proxima IN ('CWB','SP')),
  prioridade          INTEGER NOT NULL,
  ativo               BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO fornecedores (regra_tipo, regra_valor, nome, filial_proxima, prioridade) VALUES
  ('prefixo',       '19',  'Diversos', 'CWB', 10),
  ('prefixo',       'LD',  'LDRU',     'SP',  20),
  ('prefixo',       'TH',  'Tiger',    'SP',  30),
  ('prefixo',       'L0',  'LEFS',     'SP',  40),
  ('prefixo',       'CAK', 'Delphi',   'SP',  50),
  ('prefixo',       'CS',  'Delphi',   'SP',  60),
  ('prefixo',       'G',   'GAUSS',    'CWB', 70),
  ('prefixo',       'M',   'MRMK',     'SP',  80),
  ('tamanho_exato', '6',   'ACA',      'CWB', 90);
```

---

## 7. API DO BACKEND

### Webhook
```
POST /api/webhook/tiny
  Recebe webhook do Tiny ERP
  Enriquece dados (estoque ambas filiais)
  Se origem tem tudo → auto-aprova e executa
  Se nao → salva como "pendente"
  Responde 200 imediatamente (processamento assincrono)
```

### Pedidos
```
GET  /api/pedidos
  Query: filial, status, data_inicio, data_fim, busca
  Retorna lista paginada com itens incluidos

POST /api/pedidos/:id/aprovar
  Body: { decisao: "propria_filial" | "filial_suporte" | "ordem_compra" }
  Valida: pedido existe, status=pendente, usuario tem permissao na filial
  Lock otimista: falha se ja foi aprovado
  Cria etapas de execucao
  Retorna status

GET  /api/pedidos/:id
  Retorna pedido completo com itens e execucoes
```

### Health
```
GET  /api/health
  Verifica: banco ok, Tiny API acessivel
```

---

## 8. INTEGRACAO TINY ERP

### Duas contas OAuth2 independentes

```typescript
// Configuracao por filial
const CONTAS = {
  CWB: {
    nome: "NetAir",
    clientId: env.TINY_NETAIR_CLIENT_ID,
    clientSecret: env.TINY_NETAIR_CLIENT_SECRET,
    depositoPrincipalIndex: 1,  // depositos[1]
  },
  SP: {
    nome: "NetParts",
    clientId: env.TINY_NETPARTS_CLIENT_ID,
    clientSecret: env.TINY_NETPARTS_CLIENT_SECRET,
    depositoPrincipalIndex: 0,  // depositos[0]
  },
}
```

### Chamadas necessarias por pedido (ingestao)

| Chamada | Conta | Proposito |
|---------|-------|-----------|
| GET /pedidos/{id} | Origem | Detalhes do pedido |
| GET /estoque/{produtoId} | Origem | Estoque de cada item na origem |
| GET /produtos?codigo={sku} | Suporte | Buscar ID do produto na outra conta |
| GET /estoque/{produtoId} | Suporte | Estoque de cada item no suporte |

Para 500 pedidos/dia com media de 2 itens: ~3000 chamadas/dia.

### Chamadas por execucao (apos aprovacao)

**Propria filial:** 2 chamadas (marcador + NF)
**Transferencia:** 4 chamadas (marcador + NF + estorno + saida)
**OC:** 2 chamadas (marcador OC + NF)

### Rate limiting
- Fila sequencial por conta Tiny (nao paralelizar chamadas na mesma conta)
- Delay de 500ms entre chamadas
- Retry com backoff: 1s, 2s, 4s (max 3 tentativas)
- Se Tiny retorna 429: pausar fila por tempo indicado no header

---

## 9. REGRAS DE NEGOCIO COMPLETAS

### 9.1 Classificacao do pedido

Para cada pedido com N itens:
```
origem_atende = TODOS os itens tem estoque_origem >= quantidade
suporte_atende = TODOS os itens tem estoque_suporte >= quantidade
parcial = NEM origem NEM suporte tem tudo, MAS juntas tem tudo
sem_estoque = lista de itens que nenhuma filial tem
```

### 9.2 Calculo da sugestao

```
SE origem_atende:
  sugestao = "propria_filial"
  filial_atendimento = filial_origem
  modo = "auto"  ← NAO passa pelo painel

SE suporte_atende:
  sugestao = "filial_suporte"
  filial_atendimento = filial_suporte
  modo = "manual"  ← PASSA pelo painel

SE parcial:
  sugestao depende de qual filial tem mais itens
  Se empate: filial do fornecedor do item mais caro
  modo = "manual"

SE nenhuma tem nada:
  sugestao = "ordem_compra"
  filial_atendimento = filial do fornecedor do item MAIS CARO
  modo = "manual"
```

### 9.3 Resolucao de conflito de fornecedores

Quando ha multiplos itens sem estoque apontando para filiais diferentes:

**Regra: prevalece a filial do fornecedor do item de MAIOR VALOR (valor_unitario * quantidade).**

Exemplo:
- Item A: R$210 → GAUSS → CWB
- Item B: R$ 87 → LDRU → SP

Item A e mais caro → sugestao aponta para CWB.

### 9.4 Mapeamento SKU → Fornecedor

Avaliado em ordem de prioridade (menor numero primeiro):

| Prio | Tipo | Valor | Fornecedor | Filial proxima |
|------|------|-------|------------|----------------|
| 10 | prefixo | 19 | Diversos | CWB |
| 20 | prefixo | LD | LDRU | SP |
| 30 | prefixo | TH | Tiger | SP |
| 40 | prefixo | L0 | LEFS | SP |
| 50 | prefixo | CAK | Delphi | SP |
| 60 | prefixo | CS | Delphi | SP |
| 70 | prefixo | G | GAUSS | CWB |
| 80 | prefixo | M | MRMK | SP |
| 90 | tamanho_exato | 6 | ACA | CWB |

Sem match: fornecedor = "VERIFICAR", filial_proxima = filial_origem.

### 9.5 Logica de transferencia inter-filial

```
A NF SEMPRE sai da filial onde o pedido ENTROU (CNPJ fiscal).
O Tiny baixa estoque automaticamente ao gerar NF.
O Tiny bloqueia duas NFs para o mesmo pedido (seguranca).

Quando SP atende pedido que entrou em CWB:
  1. Gera NF em CWB → Tiny baixa estoque CWB (automatico)
  2. Estorna CWB (entrada "E") → desfaz a baixa errada
  3. Baixa SP (saida "S") → produto sai fisicamente de SP

Resultado: NF em CWB (fiscal ok), estoque baixou em SP (fisico ok)
```

### 9.6 Lock otimista para concorrencia

```
Ao clicar "Aprovar":
  UPDATE pedidos SET status = 'aprovado' WHERE id = X AND status = 'pendente'
  Se affected_rows = 0 → outro operador ja aprovou → mostrar aviso
  Se affected_rows = 1 → sucesso → executar
```

---

## 10. NOTIFICACOES SLACK

Canal: #vendas (C07F6QL1T8Q)

Formato unificado com badge de tipo:

```
AUTO-APROVADO (filial de origem atendeu):
> 📦 Venda {EMPRESA} #{numero}
> {descricao_item1} (x{qtd}) · {descricao_item2} (x{qtd})
> Conta: {ecommerce} · Valor: R${total}
> Estoque CWB: {n} | SP: {n}
> ✓ Atendido por {FILIAL}

APROVADO COM TRANSFERENCIA:
> 📦 Venda {EMPRESA} #{numero}
> {itens resumidos}
> Conta: {ecommerce} · Valor: R${total}
> Estoque CWB: {n} | SP: {n}
> ↔ Transferido para {FILIAL_SUPORTE}
> Aprovado por: {operador}

ORDEM DE COMPRA:
> 📦 Venda {EMPRESA} #{numero}
> {itens resumidos}
> Conta: {ecommerce} · Valor: R${total}
> ⚠ Ordem de Compra · Fornecedor: {nome}
> Aprovado por: {operador}
```

---

## 11. STACK TECNICA

```
┌─ Frontend ──────────────────────────────────┐
│  React 19 + Vite + TypeScript               │
│  Tailwind CSS + shadcn/ui                   │
│  @supabase/supabase-js (auth + realtime)    │
│  TanStack Query (cache + refetch)           │
└─────────────────────────────────────────────┘

┌─ Backend ───────────────────────────────────┐
│  Node.js + Hono + TypeScript                │
│  @supabase/supabase-js (DB + auth verify)   │
│  Worker loop (processa fila de execucoes)   │
│  Tiny API client (OAuth2, rate limited)     │
│  Slack webhook (notificacoes)               │
└─────────────────────────────────────────────┘

┌─ Infra ─────────────────────────────────────┐
│  Supabase: PostgreSQL + Auth + Realtime     │
│  EasyPanel: 1 container Docker              │
│    → Backend serve API em /api/*            │
│    → Backend serve frontend em /*           │
└─────────────────────────────────────────────┘
```

### Estrutura do projeto
```
siso/
├── packages/
│   ├── api/               # Backend Hono
│   │   ├── src/
│   │   │   ├── routes/    # webhook, pedidos, auth
│   │   │   ├── services/  # tiny-api, sugestao, execucao
│   │   │   ├── worker.ts  # processa fila de execucoes
│   │   │   └── index.ts   # entry point
│   │   └── Dockerfile
│   └── web/               # Frontend React
│       ├── src/
│       │   ├── components/ # cards, fila, filtros
│       │   ├── hooks/      # useRealtime, usePedidos
│       │   ├── pages/      # Fila, Historico, Login
│       │   └── lib/        # supabase client, types
│       └── vite.config.ts
├── supabase/
│   └── migrations/        # SQL das tabelas
├── docker-compose.yml
└── package.json
```

---

## 12. FASES DE IMPLEMENTACAO

### FASE 1 - MVP (substitui o n8n)
- [ ] Supabase: tabelas + auth + RLS + seed fornecedores
- [ ] Backend: webhook handler + enriquecimento + sugestao
- [ ] Backend: auto-aprovacao para propria filial
- [ ] Backend: endpoint /aprovar + criacao de etapas de execucao
- [ ] Backend: worker que processa etapas (Tiny API + Slack)
- [ ] Frontend: login
- [ ] Frontend: fila de pedidos pendentes com aprovacao
- [ ] Frontend: aba concluidos/auto
- [ ] Docker + deploy EasyPanel
- **Entrega: sistema funcional, n8n pode ser desligado**

### FASE 2 - Robustez
- [ ] Retry automatico de etapas com erro
- [ ] Re-consulta de estoque antes de executar transferencia
- [ ] Feedback visual de progresso (etapa 1/4, 2/4...)
- [ ] Botao de re-tentar em pedidos com erro
- [ ] Logs de auditoria completos

### FASE 3 - Inteligencia (futuro)
- [ ] Dashboard de metricas
- [ ] Tabela de fornecedores editavel na UI
- [ ] Indicador de tempo pendente (amarelo/vermelho)
- [ ] Busca e filtros avancados no historico
- [ ] Exportacao CSV

---

## 13. RISCOS E MITIGACOES

| Risco | Impacto | Mitigacao |
|-------|---------|-----------|
| Tiny API fora | Pedidos ficam em "erro" | Retry 3x com backoff, botao manual |
| Token OAuth expira | Chamadas falham | Auto-refresh antes de cada batch |
| Webhook duplicado | Pedido processado 2x | UNIQUE em tiny_pedido_id |
| Estoque mudou | Transferencia com estoque errado | Re-consultar antes de executar |
| Dois aprovam ao mesmo tempo | Execucao duplicada | Lock otimista com UPDATE condicional |
| Volume alto (500/dia) | Fila grande | Auto-aprovacao reduz ~70% do volume |
| EasyPanel cai | Webhooks perdidos | Tiny re-envia webhooks sem resposta |
| Supabase Realtime delay | UI desatualizada | TanStack Query com refetch periodico como fallback |

---

## 14. DIAGRAMA FINAL

```
                         TINY ERP
                    (NetAir + NetParts)
                           │
                    Webhook POST
                    "pedido aprovado"
                           │
                           ▼
                    ┌──────────────┐
                    │   BACKEND    │
                    │  Hono / TS   │
                    └──────┬───────┘
                           │
                    Enriquece dados
                    (estoque x2 filiais)
                           │
                    Classifica pedido
                           │
              ┌────────────┴────────────┐
              │                         │
     Origem tem tudo?            Precisa transferir
              │                    ou OC?
              ▼                         ▼
     ┌────────────────┐        ┌────────────────┐
     │ AUTO-APROVAR   │        │   PENDENTE     │
     │ Executa agora  │        │ Vai pro painel │
     └───────┬────────┘        └───────┬────────┘
             │                         │
             │                  Supabase Realtimenao
             │                         │
             │                         ▼
             │                 ┌────────────────┐
             │                 │   DASHBOARD    │
             │                 │  React / Vite  │
             │                 └───────┬────────┘
             │                         │
             │                  Operador aprova
             │                         │
             ▼                         ▼
     ┌─────────────────────────────────────────┐
     │           WORKER DE EXECUCAO            │
     │  (processa fila de etapas no Supabase)  │
     │                                          │
     │  1. Inserir marcador → Tiny API          │
     │  2. Gerar NF → Tiny API                  │
     │  3. Estorno estoque → Tiny API (se transf)│
     │  4. Saida estoque → Tiny API (se transf)  │
     │  5. Notificar → Slack API                │
     └─────────────────────────────────────────┘
```
