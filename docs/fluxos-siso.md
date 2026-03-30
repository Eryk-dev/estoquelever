# SISO — Fluxos Completos do Sistema

## 1. Visao Geral — Macro Flow

```mermaid
graph TB
    subgraph ENTRADA
        W[Webhook Tiny ERP]
    end

    subgraph PROCESSAMENTO
        WP[Webhook Processor<br/>Identifica empresa, enriquece estoque]
        NF[NF Handler<br/>Reconcilia nota fiscal]
    end

    subgraph DECISAO
        AUTO[Auto-aprovacao<br/>propria sem parcial]
        PAINEL[Painel Operador<br/>/siso — Pendentes]
    end

    subgraph EXECUCAO
        WORKER[Execution Worker<br/>Deduz estoque no Tiny]
        OC[Modulo Compras<br/>/compras]
    end

    subgraph SEPARACAO
        SEP[Picking<br/>Bipagem por codigo de barras]
        EMB[Embalagem<br/>Conferencia + etiqueta]
        EXP[Expedicao<br/>Despacho final]
    end

    W -->|pedido| WP
    W -->|nota_fiscal| NF
    WP -->|propria 100%| AUTO
    WP -->|manual| PAINEL
    PAINEL -->|aprovar| WORKER
    AUTO --> WORKER
    WORKER -->|propria/transferencia| NF
    WORKER -->|oc| OC
    OC -->|itens recebidos| WORKER
    NF -->|aguardando_separacao| SEP
    SEP --> EMB
    EMB --> EXP
```

---

## 2. Fluxo de Webhook (Entrada de Pedidos)

Quando o Tiny ERP dispara um webhook, o sistema identifica se e um **pedido** ou **nota fiscal**, faz deduplicacao, enriquece com estoque de todas as empresas do grupo e calcula a sugestao de decisao.

- **Auto-aprovacao** so acontece quando o galpao de origem tem 100% dos itens (propria sem parcial).
- Todos os outros casos vao para o painel do operador como `pendente`.

```mermaid
flowchart TD
    A["POST /api/webhook/tiny"] --> B{"Tipo do evento?"}

    B -->|pedido| C["Dedup Check<br/>siso_webhook_logs"]
    B -->|nota_fiscal| D["NF Handler"]

    C -->|duplicado| E["200 OK — ignora"]
    C -->|novo| F["getEmpresaByCnpj<br/>Identifica empresa por CNPJ"]

    F --> G["getEmpresasDoGrupo<br/>Busca todas empresas do grupo"]
    G --> H["getValidTokenByEmpresa<br/>Token OAuth2 de cada empresa"]
    H --> I["enrichItemMultiEmpresa<br/>Consulta estoque em TODAS empresas"]

    I --> J["calcularSugestaoMultiGalpao"]

    J --> K{"Decisao sugerida?"}

    K -->|"Galpao origem tem tudo"| L["propria<br/>tipo_resolucao = auto"]
    K -->|"Outro galpao tem tudo"| M["transferencia<br/>tipo_resolucao = manual"]
    K -->|"Parcial"| N["propria ou transferencia<br/>tipo_resolucao = manual"]
    K -->|"Nenhum tem estoque"| O["oc<br/>tipo_resolucao = manual"]

    L --> P["AUTO-APROVACAO<br/>status = executando"]
    P --> Q["Enfileira job<br/>siso_fila_execucao"]

    M --> R["status = pendente<br/>Vai pro painel do operador"]
    N --> R
    O --> R

    Q --> S["Salva estoque normalizado<br/>siso_pedido_item_estoques"]

    D --> T["Dedup Check"]
    T -->|duplicado| E
    T -->|novo| U{"Pedido existe no DB?"}

    U -->|sim| V["Salva NF data<br/>nota_fiscal_id, url_danfe"]
    U -->|nao| W["status = aguardando_pedido<br/>Retry depois"]

    V --> X{"status_separacao == aguardando_nf?"}
    X -->|sim| Y["Transiciona para<br/>aguardando_separacao"]
    X -->|nao| Z["Mantem status atual<br/>NF data salvo mesmo assim"]
```

### Logica de decisao detalhada

| Cenario | Decisao | Resolucao | Auto? |
|---|---|---|---|
| Galpao de origem tem 100% dos itens | `propria` | `auto` | Sim |
| Outro galpao tem 100% | `transferencia` | `manual` | Nao |
| Nenhum galpao tem 100%, parcial | `propria` ou `transferencia` (quem cobre mais) | `manual` | Nao |
| Nenhum galpao tem estoque | `oc` (ordem de compra) | `manual` | Nao |

---

## 3. Fluxo de Aprovacao + Execution Worker

Apos o operador aprovar no painel, o pedido entra na fila de execucao. O worker deduz estoque no Tiny ERP conforme o tipo de decisao.

```mermaid
flowchart TD
    A["Operador clica Aprovar<br/>POST /api/pedidos/aprovar"] --> B["Valida: status == pendente"]
    B --> C["Resolve grupo + tier order<br/>getOrdemDeducao"]
    C --> D["Update pedido<br/>status = executando<br/>decisao_final = escolha"]

    D --> E["Enfileira job<br/>siso_fila_execucao<br/>tipo = lancar_estoque"]
    E --> F["Registra historico<br/>evento = aprovado"]

    F --> G["Worker: /api/worker/processar<br/>Claim atomico do job"]

    G --> H{"Tipo de decisao?"}

    H -->|propria| I["executarSaidaPropria"]
    H -->|transferencia| J["executarSaidaTransferencia"]
    H -->|oc| K["executarMarcadoresOnly"]

    I --> L["1. Insere marcadores no Tiny<br/>2. Gera/busca NF<br/>3. Lanca saida de estoque<br/>4. estoque_saida_lancada = true"]

    J --> M["1. Insere marcadores<br/>2. Acha empresa com 100% estoque<br/>3. Gera NF na empresa ORIGEM<br/>4. Deduz estoque da empresa SUPORTE<br/>5. empresa_deducao_id = suporte"]

    K --> N["1. Insere marcadores<br/>2. Calcula qtd faltante<br/>3. Cria itens de compra<br/>4. status_separacao = aguardando_compra"]

    L --> O{"Sucesso?"}
    M --> O

    O -->|sim| P["status = concluido<br/>status_separacao = aguardando_nf"]
    O -->|"erro, tentativas < 3"| Q["Backoff exponencial<br/>30s - 60s - 120s"]
    O -->|"erro, tentativas = 3"| R["status = erro<br/>Alerta admin"]

    Q --> G
```

### Detalhes do Execution Worker

| Decisao | O que faz no Tiny | Empresa de deducao |
|---|---|---|
| `propria` | Gera NF + lanca saida (tipo S) | Empresa de origem |
| `transferencia` | Gera NF na origem + deduz estoque no suporte | Empresa do outro galpao |
| `oc` | Apenas marcadores | Nenhuma (aguarda compra) |

### Retry com backoff exponencial

| Tentativa | Delay | Acao |
|---|---|---|
| 1 | 30 segundos | Retry automatico |
| 2 | 60 segundos | Retry automatico |
| 3 | 120 segundos | Retry automatico |
| 4+ | — | status = erro, alerta admin |

---

## 4. Fluxo de Separacao (Picking - Embalagem - Expedicao)

O fluxo de separacao usa **wave picking** com bipagem por codigo de barras. Multiplos pedidos sao processados simultaneamente num checklist consolidado por SKU.

```mermaid
flowchart TD
    A["Operador seleciona pedidos<br/>Tab: Aguardando Separacao"] --> B["POST /api/separacao/iniciar<br/>pedido_ids + operador_id"]

    B --> C["status_separacao = em_separacao<br/>operador_id atribuido"]
    C --> D["RPC: consolidar_produtos_separacao<br/>Checklist consolidado por SKU"]
    C --> E["preCriarAgrupamentosEmLote<br/>Cria agrupamentos Tiny + cache ZPL<br/>ASYNC fire-and-forget"]

    D --> F["WAVE PICKING<br/>Operador bipa codigos de barras"]

    F --> G["POST /api/separacao/bipar<br/>codigo = GTIN ou SKU"]
    G --> H["Rate limit: max 2 bips/seg"]
    H --> I["RPC: processar_bip"]

    I --> J{"Resultado?"}
    J -->|parcial| F
    J -->|item_completo| F
    J -->|nao_encontrado| K["Audio erro + mensagem"]
    J -->|ja_completo| L["Audio aviso"]

    J -->|pedido_completo| M["IMPRIME ETIQUETA<br/>buscarEImprimirEtiqueta"]
    M -->|"ZPL cached"| N["FAST PATH ~200ms<br/>Envia direto pro PrintNode"]
    M -->|"ZPL nao cached"| O["SLOW PATH ~3-5s<br/>Cria agrupamento - download ZPL"]

    N --> F
    O --> F

    F -->|"todos bipados"| P["POST /api/separacao/concluir"]
    P --> Q["status_separacao = separado<br/>Retry etiquetas faltantes"]

    Q --> R["EMBALAGEM<br/>Tab: Separados"]

    R --> S{"Metodo?"}
    S -->|barcode| T["POST /api/separacao/bipar-embalagem<br/>SKU por SKU"]
    S -->|manual| U["POST /api/separacao/confirmar-item-embalagem<br/>Click no item"]

    T --> V["Incrementa quantidade_embalado"]
    U --> V

    V --> W{"Pedido completo?"}
    W -->|nao| R
    W -->|sim| X["status_separacao = embalado<br/>Claim atomico - imprime etiqueta"]

    X --> Y["EXPEDICAO<br/>Tab: Embalados"]
    Y --> Z["POST /api/separacao/expedir"]
    Z --> AA["status_separacao = expedido<br/>expedido_em = now"]
```

### Maquina de estados da separacao

```mermaid
stateDiagram-v2
    [*] --> aguardando_compra: OC pendente
    [*] --> aguardando_nf: Aprovado, esperando NF
    [*] --> aguardando_separacao: NF chegou ou auto-aprovado

    aguardando_compra --> aguardando_nf: Compra concluida
    aguardando_compra --> aguardando_separacao: Compra concluida + NF ja chegou
    aguardando_nf --> aguardando_separacao: Webhook NF recebido
    aguardando_separacao --> em_separacao: Operador inicia picking
    em_separacao --> separado: Todos itens bipados + concluido
    separado --> embalado: Todos itens embalados
    embalado --> expedido: Operador despacha
    expedido --> [*]

    em_separacao --> aguardando_separacao: Forcar pendente ou Reiniciar
    separado --> em_separacao: Voltar etapa

    aguardando_compra --> em_separacao: Pick OC (iniciar)
    note right of aguardando_compra: Pick OC: atalho para separar<br/>itens OC fisicamente disponiveis
```

### Acoes especiais durante separacao

| Acao | Endpoint | Efeito |
|---|---|---|
| Desfazer bip | `POST /api/separacao/desfazer-bip` | Reverte ultima bipagem |
| Produto esgotado | `POST /api/separacao/produto-esgotado` | Marca item como indisponivel |
| Reimprimir etiqueta | `POST /api/separacao/reimprimir` | Reenvia ZPL para PrintNode |
| Forcar pendente | `POST /api/separacao/forcar-pendente` | Volta pedido(s) para aguardando_separacao |
| Voltar etapa | `POST /api/separacao/voltar-etapa` | Retrocede um status |
| Cancelar separacao | `POST /api/separacao/cancelar` | Cancela separacao em andamento |
| Reiniciar separacao | `POST /api/separacao/reiniciar` | Reseta marcacoes e reinicia |
| Concluir OC | `POST /api/separacao/concluir-oc` | Conclui pick OC: auto-resolve compra, enfileira execucao |

### Pick OC — Atalho de Separacao para Itens Aguardando Compra

Quando os itens estao fisicamente disponiveis no galpao (ex.: fornecedor entregou antes), o operador pode separar diretamente sem esperar o fluxo formal de compras.

```mermaid
flowchart TD
    A["Operador na aba Aguardando OC<br/>Seleciona pedidos"] --> B["POST /api/separacao/iniciar<br/>Agora aceita aguardando_compra"]

    B --> C["status_separacao = em_separacao<br/>Checklist com badges OC"]
    C --> D["WAVE PICKING<br/>Itens OC mostram badge colorido:<br/>amarelo=aguardando, azul=comprado, verde=recebido"]

    D --> E["POST /api/separacao/concluir-oc<br/>Endpoint especifico para Pick OC"]

    E --> F["1. Verifica todos itens marcados"]
    F --> G["2. Auto-resolve itens OC<br/>compra_status → recebido"]
    G --> H["3. Resolve decisao"]

    H --> I{"Galpao OC == Galpao origem?"}
    I -->|sim| J["decisao = propria"]
    I -->|nao| K["decisao = transferencia"]
    I -->|"sem OC vinculada"| J

    J --> L["4. Update pedido:<br/>status=executando<br/>status_separacao=separado<br/>tag 'pick oc'"]
    K --> L

    L --> M["5. Enfileira job execucao<br/>siso_fila_execucao"]
    M --> N["6. Fire-and-forget:<br/>kickWorker + agrupamentos + historico"]

    N --> O["Execution Worker processa:<br/>lanca estoque, gera NF, marcadores"]
```

---

## 5. Fluxo de Compras (Ordem de Compra)

Quando um pedido tem decisao `oc`, os itens ficam aguardando compra. O operador/comprador cria ordens de compra agrupadas por fornecedor, recebe os itens na conferencia, e o sistema libera automaticamente os pedidos bloqueados.

```mermaid
flowchart TD
    A["Pedido com decisao = oc<br/>status_separacao = aguardando_compra"] --> B["GET /api/compras<br/>Lista itens por fornecedor"]

    B --> C["Agrupado por fornecedor<br/>SKU prefix identifica fornecedor"]

    C --> D["Operador cria OC<br/>POST /api/compras/ordens"]
    D --> E["siso_ordens_compra criada<br/>status = aberto<br/>Itens: compra_status = comprado"]

    E --> F["Fornecedor envia produtos<br/>processo manual"]

    F --> G["CONFERENCIA<br/>/compras/conferencia/ordemCompraId"]
    G --> H["POST /api/compras/conferir<br/>itens + quantidade_recebida"]

    H --> I["Para cada item:"]
    I --> J["1. Optimistic lock check<br/>2. Update quantidade_recebida<br/>3. Tiny: movimentarEstoque tipo=E<br/>4. Upsert estoque normalizado"]

    J --> K{"Tiny falhou?"}
    K -->|sim| L["ROLLBACK DB<br/>Restaura valor anterior<br/>Pula item"]
    K -->|nao| M{"Item totalmente recebido?"}

    M -->|sim| N["compra_status = recebido"]
    M -->|nao| O["Continua parcial"]

    N --> P["Verifica OC completa"]
    P --> Q{"Todos itens recebidos?"}
    Q -->|sim| R["OC status = recebido"]
    Q -->|parcial| S["OC status = parcialmente_recebido"]

    R --> T["checkAndReleasePedidos"]
    S --> T

    T --> U{"Todos itens OC do pedido resolvidos?"}
    U -->|nao| V["Pedido continua aguardando"]
    U -->|sim| W["LIBERA PEDIDO"]

    W --> X{"Galpao OC == Galpao pedido?"}
    X -->|sim| Y["decisao = propria"]
    X -->|nao| Z["decisao = transferencia"]

    Y --> AA["Enfileira execution job<br/>status_separacao = aguardando_nf<br/>ou aguardando_separacao se NF ja chegou"]
    Z --> AA
```

### Mapeamento SKU - Fornecedor

| Prefixo SKU | Fornecedor | Galpao padrao |
|---|---|---|
| `19` | Diversos | CWB |
| `EW` | Eletricway | SP |
| `LD` | LDRU | SP |
| `TH`, `TG` | Tiger | SP |
| `L0` | LEFS | SP |
| 6 digitos numericos | ACA | CWB |
| `G` | GAUSS | CWB |
| `M` | MRMK | SP |
| `CAK`, `CS` | Delphi | SP |

### Excecoes de compra

| Acao | Endpoint | Efeito |
|---|---|---|
| Item indisponivel | `POST /api/compras/itens/{id}/indisponivel` | Marca como indisponivel, reavalia pedido |
| Devolver item | `POST /api/compras/itens/{id}/devolver` | Reverte entrada no Tiny (saida estoque) |
| Trocar fornecedor | `POST /api/compras/itens/{id}/trocar-fornecedor` | Cancela e cria novo item para outro fornecedor |
| Produto equivalente | `POST /api/compras/itens/{id}/equivalente` | Substitui por produto alternativo |
| Cancelar item | `POST /api/compras/itens/{id}/cancelamento` | Cancela item da OC |

---

## 6. Fluxo de Autenticacao

Autenticacao customizada via PIN de 4 digitos (sem Supabase Auth). Sessoes duram 8 horas.

```mermaid
flowchart TD
    A["Pagina /login<br/>Nome + PIN 4 digitos"] --> B["POST /api/auth/login"]

    B --> C["Query siso_usuarios<br/>WHERE nome = input AND ativo = true"]

    C --> D{"Usuario encontrado + PIN valido?"}
    D -->|nao| E["401 Unauthorized"]
    D -->|sim| F["Busca galpoes permitidos<br/>siso_usuario_galpoes"]

    F --> G["Cria sessao<br/>siso_sessoes<br/>expira_em = now + 8h"]
    G --> H["Retorna: usuario + sessionId"]

    H --> I["Cliente salva em localStorage<br/>siso_user + siso_active_galpao"]
    I --> J["Redireciona para /siso"]

    J --> K["Toda request via sisoFetch"]
    K --> L["Headers automaticos:<br/>X-Session-Id + X-Galpao-Id"]

    L --> M["getSessionUser no servidor"]
    M --> N{"Sessao valida + nao expirada?"}
    N -->|nao| O["401 - Redireciona /login"]
    N -->|sim| P{"Cargo tem permissao?"}

    P -->|nao| Q["403 Forbidden"]
    P -->|sim| R["Processa request"]
```

### Roles e permissoes

| Cargo | Acesso |
|---|---|
| `admin` | Tudo — configuracoes, usuarios, monitoramento, todos os modulos |
| `operador_cwb` | Pedidos do galpao CWB, separacao CWB |
| `operador_sp` | Pedidos do galpao SP, separacao SP |
| `comprador` | Modulo de compras (OC) |

---

## 7. Fluxo de Impressao de Etiquetas

O sistema usa uma estrategia de **pre-criacao lazy** para minimizar o tempo de impressao durante o picking. ZPL e cacheado no banco e enviado direto para a impressora termica via PrintNode.

```mermaid
flowchart TD
    A["Trigger: pedido completo no picking<br/>ou embalagem concluida"] --> B{"ZPL ja cacheado?"}

    B -->|"sim FAST ~200ms"| C["Claim atomico<br/>siso_claim_etiqueta<br/>etiqueta_status = imprimindo"]
    B -->|"nao SLOW ~3-5s"| D["Cria agrupamento no Tiny<br/>Conclui agrupamento<br/>Download ZIP com ZPL"]

    C --> E{"Claim bem sucedido?"}
    E -->|"nao — outro operador ja pegou"| F["Skip — evita duplicata"]
    E -->|sim| G["Resolve impressora<br/>Config do usuario ou galpao"]

    D --> H["Cache ZPL no DB<br/>siso_pedidos.etiqueta_zpl"]
    H --> C

    G --> I["POST PrintNode /printjobs<br/>contentType = raw<br/>content = ZPL"]

    I --> J{"PrintNode OK?"}
    J -->|sim| K["etiqueta_status = impresso<br/>impresso_em = now"]
    J -->|nao| L["etiqueta_status = falhou<br/>Retry na proxima conclusao"]
```

### Pre-criacao de agrupamentos (async)

```mermaid
flowchart LR
    A["Ao iniciar separacao"] --> B["preCriarAgrupamentosEmLote"]
    B --> C["Agrupa pedidos por:<br/>empresa + forma_envio + frete"]
    C --> D["Para cada grupo:<br/>1. Cria agrupamento Tiny<br/>2. Conclui<br/>3. Download ZPL<br/>4. Cache no DB"]
    D --> E["Quando pedido completar<br/>ZPL ja estara cacheado<br/>Fast path"]
```

### Performance de impressao

| Caminho | Tempo | Quando acontece |
|---|---|---|
| **Fast path** | ~200ms | ZPL pre-cacheado (maioria dos casos) |
| **Slow path** | ~3-5s | Agrupamento nao criado previamente |
| **Retry** | Proxima conclusao | PrintNode falhou ou ZPL corrompido |

---

## 8. Modelo de Dados (Entidades Principais)

```mermaid
erDiagram
    siso_galpoes ||--o{ siso_empresas : "tem N"
    siso_empresas }o--|| siso_grupo_empresas : "pertence a 1 grupo"
    siso_grupo_empresas }o--|| siso_grupos : "grupo"

    siso_pedidos }o--|| siso_empresas : "empresa_origem"
    siso_pedidos ||--o{ siso_pedido_itens : "tem N itens"
    siso_pedido_itens ||--o{ siso_pedido_item_estoques : "estoque por empresa"
    siso_pedido_item_estoques }o--|| siso_empresas : "empresa"

    siso_pedidos ||--o{ siso_pedido_historico : "audit trail"
    siso_pedidos ||--o| siso_fila_execucao : "job de execucao"
    siso_pedido_itens }o--o| siso_ordens_compra : "OC vinculada"

    siso_empresas ||--o| siso_tiny_connections : "conexao Tiny"
    siso_usuarios ||--o{ siso_sessoes : "sessoes"

    siso_galpoes {
        uuid id PK
        string nome UK
        string descricao
        boolean ativo
    }

    siso_empresas {
        uuid id PK
        string nome
        string cnpj UK
        uuid galpao_id FK
        boolean ativo
    }

    siso_grupos {
        uuid id PK
        string nome UK
    }

    siso_grupo_empresas {
        uuid empresa_id FK_UK
        uuid grupo_id FK
        int tier
    }

    siso_pedidos {
        uuid id PK
        bigint numero_pedido_tiny
        string status
        string status_separacao
        string decisao_sugerida
        string decisao_final
        string tipo_resolucao
        uuid empresa_origem_id FK
        uuid separacao_galpao_id FK
        string etiqueta_zpl
        string etiqueta_status
        string agrupamento_expedicao_id
        bigint nota_fiscal_id
    }

    siso_pedido_itens {
        uuid id PK
        uuid pedido_id FK
        string produto_id
        string sku
        string descricao
        int quantidade
        boolean estoque_saida_lancada
        string compra_status
        int compra_quantidade_recebida
        uuid ordem_compra_id FK
        uuid empresa_deducao_id FK
    }

    siso_pedido_item_estoques {
        uuid pedido_id FK
        string produto_id
        uuid empresa_id FK
        float saldo
        float disponivel
        float reservado
    }

    siso_ordens_compra {
        uuid id PK
        string fornecedor
        uuid galpao_id FK
        string status
    }

    siso_fila_execucao {
        uuid id PK
        uuid pedido_id FK
        uuid empresa_id FK
        string tipo
        string decisao
        int tentativas
        timestamp proximo_em
        boolean processando
    }

    siso_usuarios {
        uuid id PK
        string nome UK
        string pin
        string cargo
        boolean ativo
    }

    siso_sessoes {
        uuid id PK
        uuid usuario_id FK
        timestamp expira_em
    }
```

---

## 9. Resumo de Todas as Transicoes de Status

### pedidos.status

```mermaid
stateDiagram-v2
    [*] --> pendente: Webhook recebido
    pendente --> executando: Aprovado (manual ou auto)
    executando --> concluido: Worker executou com sucesso
    executando --> erro: Max retries excedido
    pendente --> cancelado: Webhook de cancelamento
    executando --> cancelado: Webhook de cancelamento
```

### pedidos.status_separacao

```mermaid
stateDiagram-v2
    [*] --> aguardando_compra: Decisao = OC
    [*] --> aguardando_nf: Decisao = propria/transferencia
    [*] --> aguardando_separacao: Auto-aprovado + NF simultanea

    aguardando_compra --> aguardando_nf: Todos itens OC recebidos
    aguardando_compra --> aguardando_separacao: OC recebido + NF ja chegou
    aguardando_nf --> aguardando_separacao: Webhook NF processado
    aguardando_separacao --> em_separacao: Operador inicia picking
    em_separacao --> separado: Picking concluido
    separado --> embalado: Embalagem concluida
    embalado --> expedido: Despacho realizado

    em_separacao --> aguardando_separacao: Forcar pendente
    separado --> em_separacao: Voltar etapa
```

### pedido_itens.compra_status

```mermaid
stateDiagram-v2
    [*] --> comprado: OC criada
    comprado --> recebido: Conferencia completa
    comprado --> cancelado: Cancelado pelo operador
    comprado --> indisponivel: Fornecedor nao tem
    indisponivel --> comprado: Reordenado
```

### Sistemas Externos Integrados

| Sistema | Protocolo | Funcao |
|---|---|---|
| **Tiny ERP v3** | REST API + OAuth2 (Keycloak) | Pedidos, NF, estoque, agrupamentos |
| **Supabase** | PostgreSQL + Realtime | Banco de dados, RPCs, subscriptions |
| **PrintNode** | REST API | Impressao termica (ZPL + PDF) |

---

## 10. Hierarquia Organizacional

```mermaid
graph TD
    subgraph "Grupo: Autopecas"
        subgraph "Galpao CWB"
            E1["Empresa: NetAir<br/>CNPJ: 34857388000163<br/>Tier: 1"]
        end
        subgraph "Galpao SP"
            E2["Empresa: NetParts<br/>CNPJ: 34857388000244<br/>Tier: 1"]
        end
    end

    E1 ---|"Consulta estoque cruzado"| E2
```

### Como funciona a consulta cruzada

1. Pedido chega para a **NetAir** (CWB)
2. Sistema consulta estoque na **NetAir** E na **NetParts** (mesmo grupo)
3. Agrega por galpao: estoque CWB vs estoque SP
4. Sugere decisao baseado em qual galpao cobre mais itens
5. Se CWB cobre 100% = `propria` (auto-aprova)
6. Se SP cobre 100% = `transferencia` (painel)
7. Nenhum cobre = `oc` (compra)
