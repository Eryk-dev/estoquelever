# SISO - Escopo Definitivo v3
## Sistema Inteligente de Separacao de Ordens
### Revisado apos analise de arquitetura

---

## 1. RESUMO EXECUTIVO

Aplicacao web fullstack que substitui o workflow n8n de processamento de pedidos multi-filial.

**Dois modos de operacao:**
- **Automatico**: Filial de origem tem todos os itens → processa sem humano
- **Aprovacao manual**: Precisa de transferencia ou OC → gestor do galpao aprova

**Numeros:** ~500 pedidos/dia, 2 filiais (CWB e SP), operadores em PC, prioridade e assertividade.

**Mudanca principal vs n8n:** O n8n processava cada ITEM independentemente. O SISO processa o PEDIDO como unidade. A decisao e por pedido inteiro, nao por item.

---

## 2. REGRA DE DECISAO

```
PEDIDO CHEGA
  │
  ├─ Origem tem TODOS os itens?
  │   SIM → AUTO-APROVAR (sem painel)
  │   NAO ↓
  │
  ├─ Suporte tem TODOS os itens?
  │   SIM → PAINEL: sugere transferencia (caminho natural)
  │         Opcoes: Transferir [sugerido] | Propria filial [aviso]
  │         OC NAO aparece (suporte resolve)
  │   NAO ↓
  │
  ├─ Estoque parcial (juntas tem tudo)?
  │   → PAINEL: operador decide qual filial consolida
  │   → Sugestao: filial com maior valor total coberto
  │   → Opcoes: CWB | SP | OC
  │   NAO ↓
  │
  └─ Nenhuma tem nada?
      → PAINEL: OC sugerida
      → Filial = fornecedor do item mais caro
      → Opcoes: CWB | SP | OC [sugerido]
```

### O que aparece no painel vs o que nao aparece

| Cenario | Painel? | Opcoes visiveis |
|---------|---------|-----------------|
| Origem tem 100% | NAO (auto) | - |
| Suporte tem 100% | SIM | Transferir (sugerido) · Propria filial |
| Parcial (juntas tem) | SIM | CWB · SP · OC |
| Nenhuma tem nada | SIM | CWB · SP · OC (sugerido) |

---

## 3. FLUXO COMPLETO

### FASE 1: Ingestao (automatica)

```
1. Tiny ERP envia webhook POST
2. Backend valida:
   - tipo == "atualizacao_pedido" E codigoSituacao == "aprovado"
   - Se nao: responde 200 e ignora
3. Deduplicacao: INSERT ON CONFLICT (tiny_pedido_id) DO NOTHING
   - Se duplicado: responde 200 e ignora
4. Responde 200 ao Tiny IMEDIATAMENTE (processamento assincrono)
5. Identifica filial pelo CNPJ:
   - 34857388000163 → CWB (NetAir)
   - 34857388000244 → SP (NetParts)
6. Consulta detalhes do pedido na API Tiny
7. Para CADA ITEM:
   a. Consulta estoque na filial ORIGEM
   b. Busca produto na filial SUPORTE pelo SKU
   c. Consulta estoque na filial SUPORTE
   d. Identifica fornecedor pelo SKU (tabela de regras)
   e. Registra timestamp da consulta de estoque
8. Classifica e calcula sugestao (regras da secao 9)
9. Salva no Supabase com status adequado
```

### FASE 2A: Auto-aprovacao (origem tem tudo)

```
10a. status = "auto_aprovado", modo = "auto"
11a. Cria etapas de execucao na tabela execucoes
12a. Worker processa:
     1. Inserir marcador da filial de origem
     2. Gerar NF
     3. Notificar Slack
13a. status = "concluido"
```

Nao aparece no painel. Visivel apenas na aba "Auto (hoje)".

### FASE 2B: Fila de aprovacao (precisa de humano)

```
10b. status = "pendente", modo = "manual"
11b. Dashboard atualiza via Supabase Realtime
12b. Operador ve card com:
     - Dados do pedido + tabela de itens + estoques
     - Opcoes conforme cenario (ver secao 2)
     - Sugestao pre-selecionada
13b. Operador clica "Aprovar"
14b. Lock otimista: UPDATE WHERE status = 'pendente'
     - Se outro ja aprovou → aviso + card some
15b. status = "aprovado"
```

### FASE 2C: Desfazer aprovacao

```
O operador pode desfazer uma aprovacao desde que a NF ainda NAO tenha sido gerada.

16c. Operador vai na aba "Concluidos", acha o pedido, clica "Desfazer"
17c. Backend verifica: etapa "nota_fiscal" ja executou?
     - NAO → Cancela execucoes pendentes, volta status para "pendente"
     - SIM → Nao permite (NF e irreversivel no Tiny)
18c. Pedido volta para a fila de pendentes
```

### FASE 3: Execucao (apos aprovacao)

**Ordem de execucao com ponto de nao-retorno identificado:**

**OPCAO A - Propria filial atende:**
```
1. Inserir marcador: tag da filial de origem (ex: "CWB")
2. ── PONTO SEM RETORNO ──
3. Gerar NF (Tiny baixa estoque automaticamente)
4. Notificar Slack
```

**OPCAO B - Transferencia inter-filial:**
```
1. Validar estoque na filial suporte (re-consulta fresca)
   → Se insuficiente: abortar, status = "erro", alertar operador
2. Inserir marcador: tag da filial que VAI ENVIAR (ex: se SP envia, tag = "SP")
3. ── PONTO SEM RETORNO ──
4. Gerar NF na filial ORIGINAL (CNPJ fiscal)
   → Tiny baixa estoque na origem automaticamente
5. Estornar estoque na origem (entrada "E", por item)
   → "Estorno pedido {numero}, Atendido por {filial_suporte}"
6. Baixar estoque no suporte (saida "S", por item)
   → "Saida para atender pedido {numero}, {filial_origem}"
7. Notificar Slack: "Transferido para {FILIAL}"
```

**OPCAO C - Ordem de compra:**
```
1. Inserir marcadores OC baseados no SKU (fornecedor + filial proxima)
2. ── PONTO SEM RETORNO ──
3. Gerar NF na filial de origem
4. Registrar OC no banco
5. Notificar Slack: "Ordem de Compra - {fornecedor}"
```

**Regra de falha:** Se etapa N falha, etapa N+1 NAO executa. Retry 3x com backoff (1s, 2s, 4s). Apos 3 falhas: status = "erro", alerta Slack no canal admin.

**Regra do marcador (tag):**
- A tag sempre indica a filial que VAI ENVIAR FISICAMENTE o pedido
- Auto-aprovado CWB → tag "CWB"
- Transferencia para SP → tag "SP"
- OC → tag do fornecedor + filial proxima

---

## 4. USUARIOS E AUTENTICACAO

| Papel | Permissao | Ve no painel |
|-------|-----------|-------------|
| Operador CWB | Aprovar/desfazer pedidos NetAir | Fila CWB + historico CWB |
| Operador SP | Aprovar/desfazer pedidos NetParts | Fila SP + historico SP |
| Admin | Tudo | Ambas filas + erros + config |

- Login: email + senha (Supabase Auth)
- Multiplos operadores por filial: SIM
- Concorrencia: lock otimista (UPDATE condicional)

### RLS Policies (Row Level Security)
```sql
-- Operadores veem apenas pedidos da sua filial
CREATE POLICY pedidos_por_filial ON pedidos
  FOR SELECT USING (
    filial_origem = (SELECT filial FROM perfis WHERE id = auth.uid())
    OR (SELECT filial FROM perfis WHERE id = auth.uid()) = 'ADMIN'
  );

-- Operadores so aprovam pedidos da sua filial
CREATE POLICY aprovar_pedidos ON pedidos
  FOR UPDATE USING (
    filial_origem = (SELECT filial FROM perfis WHERE id = auth.uid())
    OR (SELECT filial FROM perfis WHERE id = auth.uid()) = 'ADMIN'
  );

-- Itens herdam acesso do pedido pai
CREATE POLICY itens_por_pedido ON pedido_itens
  FOR SELECT USING (
    pedido_id IN (SELECT id FROM pedidos)  -- herda da policy de pedidos
  );

-- Backend (service role) bypassa RLS para webhook e worker
```

---

## 5. TELAS DO DASHBOARD

### Principios de design
- Desktop-first, informacao densa mas clara
- "Caixa de entrada" - olhar, decidir, proximo
- Um clique pra aprovar (sugestao pre-selecionada)
- Opcoes visiveis mudam conforme cenario (nao mostrar OC quando nao faz sentido)
- Indicador de tempo: badge amarelo >30min, vermelho >1h
- Feedback pos-aprovacao: toast com status

### 5.1 Fila de Pedidos (tela principal)

```
┌──────────────────────────────────────────────────────────────────────┐
│  SISO                                                                │
│  ┌────────┐ ┌────────────┐ ┌───────────┐ ┌──────┐                   │
│  │Pendente│ │ Concluidos │ │ Auto (hoje)│ │Erros │  Eryk · CWB [⏻]  │
│  │  12    │ │    138     │ │    350     │ │  2   │                   │
│  └────────┘ └────────────┘ └───────────┘ └──────┘                   │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ── SUPORTE TEM ESTOQUE (transferencia) ──────────────────────────  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #90892 · ML · Leonardo Silva · 26/06         ⏱ 12min          │  │
│  │ Envio: Mercado Envios                                          │  │
│  │                                                                │  │
│  │  Produto                          Qtd  Valor    CWB    SP     │  │
│  │  ──────────────────────────────── ───  ──────  ─────  ─────   │  │
│  │  SERVO MOTOR CXA VW (019982)       1  R$104      15      8   │  │
│  │  BOBINA IGNICAO GOL (LD4021)       2  R$ 87       0     12   │  │
│  │                                                                │  │
│  │  CWB: 1/2 itens · SP: 2/2 itens                               │  │
│  │  Estoque consultado ha 12 min                                  │  │
│  │                                                                │  │
│  │  (●) Transferir para SP     (○) Manter em CWB [falta 1 item]  │  │
│  │                                                                │  │
│  │                                           [ Aprovar → ]        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ── NENHUMA FILIAL TEM TUDO ──────────────────────────────────────  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #90894 · ML · Joao Pedro · 26/06             ⏱ 45min 🟡      │  │
│  │                                                                │  │
│  │  Produto                          Qtd  Valor    CWB    SP     │  │
│  │  ──────────────────────────────── ───  ──────  ─────  ─────   │  │
│  │  SENSOR TEMP AGUA (G1025)          1  R$210      20      5   │  │
│  │  MODULO ECU FLEX (X9876)           1  R$ 45       0      0   │  │
│  │  BOBINA IGNICAO (LD4021)           1  R$ 87       0     12   │  │
│  │                                                                │  │
│  │  CWB: 1/3 (R$210) · SP: 2/3 (R$297) · Sem estoque: 1 item   │  │
│  │                                                                │  │
│  │  (○) CWB [falta 2]  (○) SP [falta 1]  (●) OC [Forn: GAUSS]  │  │
│  │                                                                │  │
│  │                                           [ Aprovar → ]        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ── ESTOQUE PARCIAL (juntas tem tudo) ────────────────────────────  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ #90895 · Shopee · Maria · 26/06              ⏱ 1h22 🔴       │  │
│  │                                                                │  │
│  │  Produto                          Qtd  Valor    CWB    SP     │  │
│  │  ──────────────────────────────── ───  ──────  ─────  ─────   │  │
│  │  SENSOR TEMP AGUA (G1025)          1  R$210      20      0   │  │
│  │  BOBINA IGNICAO (LD4021)           2  R$174       0     12   │  │
│  │                                                                │  │
│  │  CWB: R$210 coberto · SP: R$174 coberto · Juntas: 100%       │  │
│  │                                                                │  │
│  │  (●) CWB [cobre R$210]  (○) SP [cobre R$174]  (○) OC         │  │
│  │  Itens faltantes entram em transferencia ou OC                 │  │
│  │                                                                │  │
│  │                                           [ Aprovar → ]        │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Aba "Concluidos" (hoje por padrao, com filtro de data)

```
┌────────────────────────────────────────────────────────────────────┐
│  Filtro: [Hoje ▾]  Busca: [________________]                       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ #90891 · ML · Ana · 26/06                    [AUTO] [CWB]   │  │
│  │ SENSOR PRESSÃO (G1022) x1 · R$89                             │  │
│  │ Concluido as 14:32                                            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ #90887 · Shopee · Carlos · 26/06  [TRANSFER] [SP] Eryk 14:15│  │
│  │ BOBINA IGNICAO (LD4021) x2 · R$174                           │  │
│  │ Concluido as 14:18                          [ Desfazer ]     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ #90885 · ML · Pedro · 26/06         [OC] [GAUSS] Eryk 13:50 │  │
│  │ MODULO ECU (X9876) x1 · R$45                                 │  │
│  │ Concluido as 13:55                          [ Desfazer ]     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**Botao "Desfazer":** Visivel apenas se NF ainda nao foi gerada. Se NF ja gerou, botao nao aparece.

### 5.3 Aba "Erros"
- Pedidos que falharam durante execucao
- Mostra qual etapa falhou e o erro
- Botao "Re-tentar" para re-executar a partir da etapa que falhou
- Alerta visual (badge vermelho no tab)

### 5.4 Aba "Auto (hoje)"
- Pedidos auto-aprovados do dia, apenas leitura
- Conferencia rapida

### 5.5 Comportamento geral
- Pedidos ordenados por data (mais antigo primeiro)
- Ao aprovar: toast "Pedido #X aprovado" + card some
- Se outro operador aprova: card some via Realtime
- Cards agrupados por tipo de cenario (secoes visuais)
- Badge de tempo: ⏱ normal, 🟡 >30min, 🔴 >1h
- Paginacao: 20 por pagina nos historicos

---

## 6. MODELO DE DADOS

### pedidos
```sql
CREATE TABLE pedidos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tiny_pedido_id      BIGINT NOT NULL UNIQUE,  -- Dedup de webhooks
  numero_pedido       VARCHAR NOT NULL,
  filial_origem       VARCHAR NOT NULL CHECK (filial_origem IN ('CWB','SP')),
  cnpj                VARCHAR NOT NULL,

  -- Status
  status              VARCHAR NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','auto_aprovado','aprovado','executando','concluido','erro')),
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
  valor_coberto_origem  DECIMAL(10,2) DEFAULT 0, -- Soma valor dos itens com estoque na origem
  valor_coberto_suporte DECIMAL(10,2) DEFAULT 0, -- Soma valor dos itens com estoque no suporte

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

  -- Controle de concorrencia
  versao              INTEGER NOT NULL DEFAULT 0,

  -- Meta
  webhook_raw         JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pedidos_status ON pedidos(status);
CREATE INDEX idx_pedidos_filial_status ON pedidos(filial_origem, status);
CREATE INDEX idx_pedidos_created ON pedidos(created_at DESC);
CREATE INDEX idx_pedidos_tiny_id ON pedidos(tiny_pedido_id);
```

### pedido_itens
```sql
CREATE TABLE pedido_itens (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id             UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_descricao     VARCHAR NOT NULL,
  produto_sku           VARCHAR NOT NULL,
  produto_id_origem     BIGINT,          -- ID na conta Tiny da filial de origem
  produto_id_suporte    BIGINT,          -- ID na conta Tiny da filial suporte
  quantidade            INTEGER NOT NULL,
  valor_unitario        DECIMAL(10,2) NOT NULL,
  valor_total_item      DECIMAL(10,2) NOT NULL, -- valor_unitario * quantidade
  estoque_origem        INTEGER,
  estoque_suporte       INTEGER,
  deposito_id_origem    BIGINT,          -- ID do deposito na origem (para movimentacao)
  deposito_id_suporte   BIGINT,          -- ID do deposito no suporte
  tem_estoque_origem    BOOLEAN NOT NULL DEFAULT FALSE,
  tem_estoque_suporte   BOOLEAN NOT NULL DEFAULT FALSE,
  fornecedor            VARCHAR,         -- Nome do fornecedor (via SKU)
  filial_fornecedor     VARCHAR CHECK (filial_fornecedor IN ('CWB','SP')),
  estoque_consultado_em TIMESTAMPTZ,     -- Quando o estoque foi consultado
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_itens_pedido ON pedido_itens(pedido_id);
CREATE INDEX idx_itens_sku ON pedido_itens(produto_sku);
```

### execucoes
```sql
CREATE TABLE execucoes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id           UUID NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  pedido_item_id      UUID REFERENCES pedido_itens(id), -- NULL para etapas de pedido (NF, slack)
  etapa               VARCHAR NOT NULL
    CHECK (etapa IN (
      'validar_estoque',   -- Re-consulta antes do ponto sem retorno
      'marcador',          -- Inserir tag no Tiny
      'marcador_oc',       -- Inserir tag de OC no Tiny
      'nota_fiscal',       -- Gerar NF (PONTO SEM RETORNO)
      'estorno_estoque',   -- Entrada "E" na origem (por item)
      'saida_estoque',     -- Saida "S" no suporte (por item)
      'slack'              -- Notificacao
    )),
  ordem               INTEGER NOT NULL,
  status              VARCHAR NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','executando','sucesso','erro','cancelado')),
  tentativas          INTEGER DEFAULT 0,
  max_tentativas      INTEGER DEFAULT 3,
  detalhes            JSONB,           -- Request/response da API
  erro                TEXT,
  executado_em        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_exec_pedido ON execucoes(pedido_id);
CREATE INDEX idx_exec_pendente ON execucoes(status, ordem)
  WHERE status IN ('pendente','erro');
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
  prioridade          INTEGER NOT NULL UNIQUE, -- Garante ordem deterministica
  ativo               BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Algoritmo de matching: percorrer em ORDER BY prioridade ASC.
-- Para "prefixo": SKU.startsWith(regra_valor)
-- Para "tamanho_exato": SKU.length === parseInt(regra_valor)
-- Retornar no PRIMEIRO match. Se nenhum: fornecedor = "VERIFICAR".

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

### tiny_tokens (OAuth2)
```sql
CREATE TABLE tiny_tokens (
  filial              VARCHAR PRIMARY KEY CHECK (filial IN ('CWB','SP')),
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 7. API DO BACKEND

### Webhook
```
POST /api/webhook/tiny
  1. Valida: tipo == "atualizacao_pedido" && codigoSituacao == "aprovado"
     Se nao: retorna 200 (ignora silenciosamente)
  2. Retorna 200 IMEDIATAMENTE
  3. Processa em background:
     - INSERT ON CONFLICT (tiny_pedido_id) DO NOTHING
     - Se duplicado: para aqui
     - Enriquece dados (estoque ambas filiais)
     - Classifica e calcula sugestao
     - Se auto → cria execucoes e processa
     - Se manual → salva como pendente
```

### Pedidos
```
GET  /api/pedidos
  Query: filial, status, modo, data_inicio, data_fim, busca, pagina, limite
  Retorna: lista paginada com itens incluidos
  Default: status=pendente, limite=20

GET  /api/pedidos/:id
  Retorna: pedido completo + itens + execucoes + historico

POST /api/pedidos/:id/aprovar
  Body: { decisao, observacao? }
  Valida:
    - Pedido existe
    - status == "pendente"
    - versao == versao_esperada (lock otimista)
    - Usuario tem permissao na filial
  Acao:
    - UPDATE status='aprovado', versao=versao+1
    - Cria etapas de execucao
    - Worker processa

POST /api/pedidos/:id/desfazer
  Valida:
    - Pedido existe
    - Etapa "nota_fiscal" NAO tem status "sucesso"
  Acao:
    - Cancela execucoes pendentes (status='cancelado')
    - Volta pedido para status='pendente'
    - Limpa campos de aprovacao
```

### Health
```
GET  /api/health
  Retorna: status do banco, status tokens Tiny (expiram em X), uptime
```

---

## 8. INTEGRACAO TINY ERP

### Duas contas OAuth2 independentes

```typescript
const CONTAS = {
  CWB: {
    nome: "NetAir",
    cnpj: "34857388000163",
    depositoPrincipalIndex: 1,  // depositos[1] = principal CWB
    depositoEstornoIndex: 1,    // estorno vai pro mesmo deposito
  },
  SP: {
    nome: "NetParts",
    cnpj: "34857388000244",
    depositoPrincipalIndex: 0,  // depositos[0] = principal SP
    depositoEstornoIndex: 1,    // estorno em SP usa depositos[1]
  },
}
```

### Gerenciamento de tokens
- Tokens armazenados na tabela `tiny_tokens`
- Antes de cada batch de chamadas: verificar `expires_at`
- Se expira em <5 min: fazer refresh e salvar novos tokens
- Se refresh falha: status "erro", alerta Slack admin
- Setup inicial: endpoint admin para inserir tokens pela primeira vez

### Rate limiting
- Fila sequencial POR CONTA Tiny (duas filas independentes)
- Delay de 500ms entre chamadas na mesma conta
- Se Tiny retorna 429: pausar fila pelo tempo do header Retry-After
- Retry com backoff: 1s, 2s, 4s (max 3)
- Erros 4xx (exceto 429): NAO retenta (erro de validacao)
- Erros 5xx e timeout: retenta

### Chamadas por cenario

| Cenario | Ingestao (por item) | Execucao (por pedido) |
|---------|--------------------|-----------------------|
| Auto (origem tem tudo) | 3 calls/item | 2 (marcador + NF) |
| Transferencia | 3 calls/item | 2 + 2*N_itens (marcador + NF + estorno + saida por item) |
| OC | 3 calls/item | 2 (marcador_oc + NF) |

Volume estimado: 500 pedidos * 2 itens medio * 3 calls = 3000 calls/dia ingestao + ~1500 calls/dia execucao.

---

## 9. REGRAS DE NEGOCIO

### 9.1 Classificacao do pedido

```typescript
// Para cada pedido com N itens:
const origem_atende = itens.every(i => i.estoque_origem >= i.quantidade)
const suporte_atende = itens.every(i => i.estoque_suporte >= i.quantidade)
const parcial = !origem_atende && !suporte_atende
  && itens.every(i => i.estoque_origem >= i.quantidade || i.estoque_suporte >= i.quantidade)
const sem_estoque = itens.filter(i => i.estoque_origem < i.quantidade && i.estoque_suporte < i.quantidade)

const valor_coberto_origem = itens
  .filter(i => i.estoque_origem >= i.quantidade)
  .reduce((sum, i) => sum + i.valor_unitario * i.quantidade, 0)

const valor_coberto_suporte = itens
  .filter(i => i.estoque_suporte >= i.quantidade)
  .reduce((sum, i) => sum + i.valor_unitario * i.quantidade, 0)
```

### 9.2 Calculo da sugestao

```typescript
if (origem_atende) {
  sugestao = "propria_filial"
  modo = "auto"
} else if (suporte_atende) {
  sugestao = "filial_suporte"
  modo = "manual"
} else if (parcial) {
  // Desempate por valor total coberto
  sugestao = valor_coberto_origem >= valor_coberto_suporte
    ? "propria_filial"  // origem cobre mais valor
    : "filial_suporte"  // suporte cobre mais valor
  modo = "manual"
} else {
  sugestao = "ordem_compra"
  // Filial = fornecedor do item mais caro (valor_total_item)
  const item_mais_caro = itens.sort((a, b) => b.valor_total_item - a.valor_total_item)[0]
  filial_atendimento = item_mais_caro.filial_fornecedor
  modo = "manual"
}
```

### 9.3 Mapeamento SKU → Fornecedor

```typescript
// Carregar regras em ORDER BY prioridade ASC
// Para cada SKU, iterar regras ate encontrar match:
function identificarFornecedor(sku: string, regras: Fornecedor[]): Match {
  for (const regra of regras) {
    if (regra.regra_tipo === 'prefixo' && sku.startsWith(regra.regra_valor)) {
      return { fornecedor: regra.nome, filial: regra.filial_proxima }
    }
    if (regra.regra_tipo === 'tamanho_exato' && sku.length === parseInt(regra.regra_valor)) {
      return { fornecedor: regra.nome, filial: regra.filial_proxima }
    }
  }
  return { fornecedor: 'VERIFICAR', filial: filial_origem }
}
```

### 9.4 Logica de transferencia

```
NF SEMPRE sai da filial onde o pedido ENTROU (CNPJ fiscal).
Tag (marcador) = filial que ENVIA FISICAMENTE.
Tiny baixa estoque automaticamente ao gerar NF.
Tiny bloqueia duas NFs para o mesmo pedido.

Indices de deposito (confirmados):
  CWB (NetAir):   principal = depositos[1], estorno = depositos[1]
  SP (NetParts):   principal = depositos[0], estorno = depositos[1]
```

### 9.5 Opcoes visiveis por cenario

| Cenario | Opcoes mostradas | Sugestao |
|---------|-----------------|----------|
| Suporte tem 100% | Transferir (sugerido) · Propria filial | Transferir |
| Parcial | CWB · SP · OC | Filial com maior valor coberto |
| Nenhuma tem | CWB · SP · OC | OC (filial do forn. item +caro) |

### 9.6 Desfazer aprovacao

```
PERMITIDO quando:
  - Etapa "nota_fiscal" ainda NAO executou com sucesso
  - Cancela todas execucoes com status "pendente"
  - Volta pedido para status = "pendente"
  - Pedido reaparece na fila

NAO PERMITIDO quando:
  - NF ja foi gerada (irreversivel no Tiny)
  - Botao "Desfazer" nao aparece na UI nesse caso
```

---

## 10. NOTIFICACOES SLACK

### Canal #vendas (operacional)
```
AUTO-APROVADO:
> 📦 Venda {EMPRESA} #{numero}
> {item1} (x{qtd}) · {item2} (x{qtd})
> {ecommerce} · R${total}
> ✓ Atendido por {FILIAL}

TRANSFERENCIA:
> 📦 Venda {EMPRESA} #{numero}
> {itens}
> {ecommerce} · R${total}
> ↔ Transferido para {FILIAL} · Aprovado por: {operador}

ORDEM DE COMPRA:
> 📦 Venda {EMPRESA} #{numero}
> {itens}
> {ecommerce} · R${total}
> ⚠ OC · Fornecedor: {nome} · Aprovado por: {operador}
```

### Canal admin (alertas de erro)
```
> 🔴 ERRO no pedido #{numero}
> Etapa: {etapa} · Tentativa: {n}/3
> Erro: {mensagem}
> Acao necessaria: verificar manualmente
```

---

## 11. STACK TECNICA

```
Frontend:  React 19 + Vite + TypeScript + Tailwind + shadcn/ui
           @supabase/supabase-js (auth + realtime)
           TanStack Query (cache + refetch fallback)

Backend:   Node.js + Hono + TypeScript
           @supabase/supabase-js (service role, bypassa RLS)
           Worker loop com SELECT FOR UPDATE SKIP LOCKED
           Tiny API client (OAuth2, rate limited, por conta)
           Slack Incoming Webhook

Infra:     Supabase (PostgreSQL + Auth + Realtime)
           EasyPanel (1 container Docker, auto-restart)
           Backend serve API em /api/* e frontend em /*
```

### Estrutura do projeto
```
siso/
├── packages/
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── webhook.ts       # POST /api/webhook/tiny
│   │   │   │   ├── pedidos.ts       # GET/POST /api/pedidos
│   │   │   │   └── health.ts        # GET /api/health
│   │   │   ├── services/
│   │   │   │   ├── tiny-client.ts   # API client com OAuth2 + rate limit
│   │   │   │   ├── enriquecedor.ts  # Busca estoque, classifica pedido
│   │   │   │   ├── sugestao.ts      # Calcula sugestao automatica
│   │   │   │   ├── executor.ts      # Executa etapas (marcador, NF, estoque)
│   │   │   │   ├── fornecedor.ts    # Matching SKU → fornecedor
│   │   │   │   └── slack.ts         # Envia notificacoes
│   │   │   ├── worker.ts            # Loop: processa fila de execucoes
│   │   │   ├── recovery.ts          # Startup: recupera ordens em "executando"
│   │   │   └── index.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/
│       ├── src/
│       │   ├── components/
│       │   │   ├── PedidoCard.tsx    # Card principal com opcoes
│       │   │   ├── ItemTable.tsx     # Tabela de itens com estoque
│       │   │   ├── FilaHeader.tsx    # Tabs + contadores
│       │   │   └── Toast.tsx         # Feedback pos-acao
│       │   ├── hooks/
│       │   │   ├── usePedidos.ts     # TanStack Query + Realtime
│       │   │   └── useAuth.ts        # Login/logout
│       │   ├── pages/
│       │   │   ├── Fila.tsx          # Tela principal
│       │   │   └── Login.tsx
│       │   └── lib/
│       │       ├── supabase.ts       # Client configurado
│       │       └── types.ts          # Tipos compartilhados
│       ├── vite.config.ts
│       └── package.json
├── supabase/
│   └── migrations/
│       ├── 001_tables.sql
│       ├── 002_rls.sql
│       └── 003_seed_fornecedores.sql
├── docker-compose.yml
└── package.json                      # Monorepo (workspaces)
```

---

## 12. WORKER DE EXECUCAO

### Comportamento
```typescript
// Loop principal (roda a cada 2 segundos)
async function workerLoop() {
  // Busca a proxima execucao pendente (ou com erro < max_tentativas)
  // SELECT FOR UPDATE SKIP LOCKED garante:
  //   - Apenas um worker pega cada execucao
  //   - Ordens diferentes podem processar em paralelo
  //   - Etapas da mesma ordem processam em sequencia (ORDER BY ordem)

  const exec = await db.query(`
    SELECT e.* FROM execucoes e
    JOIN pedidos p ON p.id = e.pedido_id
    WHERE e.status IN ('pendente')
    AND e.tentativas < e.max_tentativas
    AND NOT EXISTS (
      SELECT 1 FROM execucoes prev
      WHERE prev.pedido_id = e.pedido_id
      AND prev.ordem < e.ordem
      AND prev.status NOT IN ('sucesso','cancelado')
    )
    ORDER BY e.created_at ASC
    LIMIT 1
    FOR UPDATE OF e SKIP LOCKED
  `)

  if (!exec) return // nada pra fazer

  // Executar a etapa
  await processarEtapa(exec)
}
```

### Startup recovery
```typescript
// Ao iniciar, verificar ordens presas em "executando"
// (container pode ter reiniciado no meio de uma execucao)
async function recuperarOrdensPresas() {
  await db.query(`
    UPDATE execucoes SET status = 'pendente'
    WHERE status = 'executando'
    AND updated_at < NOW() - INTERVAL '5 minutes'
  `)
}
```

---

## 13. FASES DE IMPLEMENTACAO

### FASE 1 - MVP (substitui o n8n)
- [ ] Supabase: todas as tabelas + RLS + seed fornecedores
- [ ] Backend: webhook handler com validacao + dedup
- [ ] Backend: enriquecedor (estoque ambas filiais)
- [ ] Backend: classificacao + sugestao
- [ ] Backend: auto-aprovacao para propria filial
- [ ] Backend: endpoint /aprovar com lock otimista
- [ ] Backend: endpoint /desfazer com validacao pre-NF
- [ ] Backend: worker de execucao com retry
- [ ] Backend: recovery de ordens presas no startup
- [ ] Backend: Tiny client com OAuth2 + rate limit + token refresh
- [ ] Backend: Slack webhook (canal vendas + canal admin erros)
- [ ] Frontend: login
- [ ] Frontend: fila pendentes com opcoes condicionais
- [ ] Frontend: aba concluidos com desfazer
- [ ] Frontend: aba erros com re-tentar
- [ ] Frontend: aba auto (hoje)
- [ ] Frontend: badge de tempo (amarelo/vermelho)
- [ ] Frontend: toast de feedback
- [ ] Frontend: Supabase Realtime + TanStack Query fallback
- [ ] Docker + deploy EasyPanel
- **Entrega: sistema funcional, n8n desligado**

### FASE 2 - Robustez
- [ ] Re-consulta de estoque em TODAS transferencias (antes de NF)
- [ ] Botao "Atualizar estoque" no card (consulta fresca)
- [ ] Feedback visual de progresso (etapa 1/4, 2/4...)
- [ ] Logs de auditoria detalhados
- [ ] Paginacao + filtros avancados no historico

### FASE 3 - Inteligencia
- [ ] Dashboard de metricas (pedidos/dia, tipo, tempo medio)
- [ ] Tabela de fornecedores editavel na UI
- [ ] Exportacao CSV do historico
- [ ] Health check visual no admin

---

## 14. RISCOS E MITIGACOES

| Risco | Impacto | Mitigacao |
|-------|---------|-----------|
| Tiny fora do ar | Pedidos acumulam em "erro" | Retry 3x + alerta Slack + botao manual |
| Token OAuth expira | Chamadas falham | Auto-refresh pre-batch + tabela tiny_tokens |
| Refresh token invalido | Sistema para | Alerta imediato + endpoint admin pra re-autenticar |
| Webhook duplicado | Pedido duplicado | UNIQUE + ON CONFLICT DO NOTHING |
| Estoque mudou | Decisao em dados velhos | Timestamp visivel + re-consulta antes de NF |
| Dois aprovam mesmo pedido | Dupla execucao | Lock otimista com versao |
| NF gerada + prox etapa falha | Estoque inconsistente | Etapas sequenciais + retry + alerta admin |
| Container reinicia | Execucoes perdidas | Recovery no startup + Supabase duravel |
| Supabase Realtime delay | UI desatualizada | TanStack Query refetch a cada 10s como fallback |
| Volume pico (100 pedidos/hora) | Fila cresce | Auto-aprovacao alivia ~70%, worker sequencial por conta |

---

## 15. DIAGRAMA FINAL

```
                         TINY ERP
                    (NetAir + NetParts)
                           │
                    Webhook POST
                    (atualizacao_pedido + aprovado)
                           │
                           ▼
              ┌─── BACKEND (Hono/TS) ───┐
              │                          │
              │  Valida → Dedup → 200    │
              │       │                  │
              │  Enriquece (Tiny x2)     │
              │       │                  │
              │  Classifica + Sugere     │
              │       │                  │
              │  ┌────┴────┐             │
              │  │         │             │
              │ AUTO    MANUAL           │
              │  │         │             │
              │  ▼         ▼             │
              │ exec    Supabase         │
              │ agora   (pendente)       │
              │  │         │             │
              └──┼─────────┼─────────────┘
                 │         │ Realtime
                 │         ▼
                 │  ┌─────────────┐
                 │  │  DASHBOARD  │
                 │  │ React/Vite  │
                 │  └──────┬──────┘
                 │         │ Aprovar / Desfazer
                 │         │
                 ▼         ▼
              ┌──────────────────────┐
              │   WORKER EXECUCAO    │
              │                      │
              │ 1. Validar estoque   │
              │ 2. Marcador (tag)    │
              │ ── PONTO SEM VOLTA ──│
              │ 3. Gerar NF          │
              │ 4. Estorno (se transf)│
              │ 5. Saida (se transf) │
              │ 6. Slack             │
              └──────────┬───────────┘
                         │
                    ┌────┴────┐
                    │         │
                    ▼         ▼
              Tiny API    Slack API
              (2 contas)  (#vendas + #admin)
```
