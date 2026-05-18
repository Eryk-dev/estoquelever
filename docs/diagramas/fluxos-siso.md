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
        SEP[Picking Normal<br/>Bipagem por codigo de barras]
        PICKOC[Pick OC<br/>Atalho para itens fisicamente disponiveis]
        EMBOC[Embalagem Direta OC<br/>Scan direto sem picking]
        EMB[Embalagem<br/>Conferencia + etiqueta]
        EXP[Expedicao<br/>Despacho final]
    end

    subgraph RASTREAMENTO
        TRACK[Pedidos Tracking<br/>/pedidos — Busca universal]
    end

    W -->|pedido| WP
    W -->|nota_fiscal| NF
    WP -->|propria 100%| AUTO
    WP -->|manual| PAINEL
    PAINEL -->|aprovar| WORKER
    AUTO --> WORKER
    WORKER -->|propria/transferencia| NF
    WORKER -->|oc| OC
    OC -->|itens recebidos via conferencia| WORKER
    OC -->|itens fisicamente disponiveis| PICKOC
    OC -->|embalagem direta OC| EMBOC
    PICKOC -->|auto-resolve compra| WORKER
    EMBOC -->|auto-resolve + enfileira exec| WORKER
    EMBOC --> EXP
    NF -->|aguardando_separacao| SEP
    SEP --> EMB
    PICKOC --> EMB
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

    V --> AA{"chave_acesso_nf presente?"}
    AA -->|sim| AB["criarAgrupamentoFase1<br/>fire-and-forget"]
    AA -->|nao| AC["Agrupamento deixado para<br/>segunda chance futura"]
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

    I --> L["1. Insere marcadores no Tiny<br/>2. Gera/busca NF<br/>3. Lanca saida de estoque<br/>4. estoque_saida_lancada = true<br/>5. criarAgrupamentoFase1"]

    J --> M["1. Insere marcadores<br/>2. Acha empresa com 100% estoque<br/>3. Gera NF na empresa ORIGEM<br/>4. Deduz estoque da empresa SUPORTE<br/>5. empresa_deducao_id = suporte<br/>6. criarAgrupamentoFase1"]

    K --> N["1. Insere marcadores<br/>2. Gera NF sem baixar estoque<br/>3. criarAgrupamentoFase1<br/>4. Calcula qtd faltante<br/>5. Cria itens de compra<br/>6. status_separacao = aguardando_compra"]

    L --> O{"Sucesso?"}
    M --> O

    O -->|sim| P["status = concluido<br/>status_separacao = aguardando_nf"]
    O -->|"erro, tentativas < 3"| Q["Backoff exponencial<br/>30s - 60s - 120s"]
    O -->|"erro, tentativas = 3"| R["status = erro<br/>Alerta admin"]

    Q --> G
```

### Detalhes do Execution Worker

| Decisao | O que faz no Tiny | Empresa de deducao | Agrupamento |
|---|---|---|---|
| `propria` | Gera NF + lanca saida (tipo S) | Empresa de origem | Fase 1 apos estoque |
| `transferencia` | Gera NF na origem + deduz estoque no suporte | Empresa do outro galpao | Fase 1 apos estoque |
| `oc` | Marcadores + gera NF (sem estoque) | Nenhuma (aguarda compra) | Fase 1 se NF persistida |

> **OC na aprovacao:** `executarMarcadoresOnly` agora gera NF (via `gerarNotaFiscalPedido`, idempotente) e tenta `criarAgrupamentoFase1` ANTES de resolver itens de compra. Falha de NF nao bloqueia compra. Estoque de OC continua diferido para o Ciclo 2 (apos `compras-release`). O Ciclo 2 detecta NF existente e pula direto para baixa de estoque.
>
> **Failure isolation:** `criarAgrupamentoFase1` e fire-and-forget (nunca lanca excecao). Falha de agrupamento nunca causa retry do job apos `estoque_lancado`/`estoque_saida_lancada` ja persistidos.

### Retry com backoff exponencial

| Tentativa | Delay | Acao |
|---|---|---|
| 1 | 30 segundos | Retry automatico |
| 2 | 60 segundos | Retry automatico |
| 3 | 120 segundos | Retry automatico |
| 4+ | — | status = erro, alerta admin |

---

## 4. Fluxo de Separacao (Picking - Embalagem - Expedicao)

O fluxo de separacao usa **wave picking** com bipagem por codigo de barras. Multiplos pedidos sao processados simultaneamente num checklist consolidado por SKU. O checklist mostra TODOS os itens, incluindo itens OC com badges de status de compra.

```mermaid
flowchart TD
    A["Operador seleciona pedidos<br/>Tab: Aguardando Separacao ou Aguardando OC"] --> B["POST /api/separacao/iniciar<br/>pedido_ids + operador_id"]

    B --> C["BLINDAGEM: Verifica compra_status pendente<br/>Se houver itens nao resolvidos, aborta"]
    C -->|Sim - bloqueado| D["Erro 400: Resolve compra items antes<br/>Via /api/compras/conferir"]
    D --> A
    C -->|Nao - ok| E["status_separacao = em_separacao<br/>operador_id atribuido<br/>Modo pick-oc ativado se necessario"]

    E --> F["RPC: consolidar_produtos_separacao<br/>Checklist consolidado por SKU<br/>INCLUI itens OC com badges"]
    E --> G["preCriarAgrupamentosEmLote<br/>Cria agrupamentos Tiny + cache ZPL<br/>ASYNC fire-and-forget"]

    F --> H["WAVE PICKING<br/>Operador bipa codigos de barras<br/>Itens OC mostram badge amarelo/azul/verde"]

    H --> I["POST /api/separacao/bipar<br/>codigo = GTIN ou SKU"]
    I --> J["Rate limit: max 2 bips/seg"]
    J --> K["RPC: processar_bip"]

    K --> L{"Resultado?"}
    L -->|parcial| H
    L -->|item_completo| H
    L -->|nao_encontrado| M["Audio erro + mensagem"]
    L -->|ja_completo| N["Audio aviso"]

    L -->|pedido_completo| O["IMPRIME ETIQUETA<br/>buscarEImprimirEtiqueta"]
    O -->|"ZPL cached"| P["FAST PATH ~200ms<br/>Envia direto pro PrintNode"]
    O -->|"ZPL nao cached"| Q["SLOW PATH ~3-5s<br/>Cria agrupamento - download ZPL"]

    P --> H
    Q --> H

    H -->|"todos bipados"| R{"Modo Pick OC?"}
    R -->|Nao - normal| S["POST /api/separacao/concluir"]
    R -->|Sim - OC| T["POST /api/separacao/concluir-oc"]

    S --> U["status_separacao = separado<br/>Retry etiquetas faltantes"]
    T --> V["Auto-resolve compra items<br/>Determina decisao (propria/transferencia)<br/>Enfileira execution job<br/>Adiciona tag 'pick oc'"]

    U --> W["EMBALAGEM<br/>Tab: Separados"]
    V --> W

    W --> X{"Metodo?"}
    X -->|barcode| Y["POST /api/separacao/bipar-embalagem<br/>SKU por SKU"]
    X -->|manual| Z["POST /api/separacao/confirmar-item-embalagem<br/>Click no item"]

    Y --> AA["Incrementa quantidade_embalado"]
    Z --> AA

    AA --> AB{"Pedido completo?"}
    AB -->|nao| W
    AB -->|sim| AC["status_separacao = embalado<br/>Claim atomico - imprime etiqueta"]

    AC --> AD["EXPEDICAO<br/>Tab: Embalados"]
    AD --> AE["POST /api/separacao/expedir"]
    AE --> AF["status_separacao = expedido<br/>expedido_em = now"]
```

### Maquina de estados da separacao

```mermaid
stateDiagram-v2
    [*] --> aguardando_compra: OC pendente
    [*] --> aguardando_nf: Aprovado, esperando NF
    [*] --> aguardando_separacao: NF chegou ou auto-aprovado

    aguardando_compra --> aguardando_nf: Compra concluida via conferencia
    aguardando_compra --> aguardando_separacao: Compra concluida + NF ja chegou
    aguardando_nf --> aguardando_separacao: Webhook NF recebido
    aguardando_separacao --> em_separacao: Operador inicia picking
    em_separacao --> separado: Todos itens bipados + concluir
    em_separacao --> pendente_realocacao: Short pick sem cobertura no galpao
    pendente_realocacao --> em_separacao: Desfazer parcial ou supervisor reabre
    separado --> embalado: Todos itens embalados
    embalado --> expedido: Operador despacha
    expedido --> [*]

    em_separacao --> aguardando_separacao: Forcar pendente
    separado --> em_separacao: Voltar etapa

    aguardando_compra --> em_separacao: Pick OC - inicia separacao OC<br/>Operador resolve compra items primeiro
    em_separacao --> separado: Concluir OC - auto-resolve compra
    note right of aguardando_compra: Pick OC: atalho para separar<br/>itens OC fisicamente disponiveis<br/>Blindagem: itens com compra pendente<br/>nao transitam para em_separacao
    note right of pendente_realocacao: Short pick: operador encontrou menos<br/>unidades que o pedido + galpao nao tem<br/>cobertura em nenhuma outra localizacao
```

### Acoes especiais durante separacao

| Acao | Endpoint | Entrada | Efeito |
|---|---|---|---|
| Desfazer bip | `POST /api/separacao/desfazer-bip` | pedido_id, codigo | Reverte ultima bipagem, atualiza quantidade_bipada |
| Produto esgotado | `POST /api/separacao/produto-esgotado` | pedido_id, item_id | Marca item como indisponivel, desconta do checklist |
| Reimprimir etiqueta | `POST /api/separacao/reimprimir` | pedido_id, printer_id | Reenvia ZPL cacheado para PrintNode |
| Forcar pendente | `POST /api/separacao/forcar-pendente` | pedido_ids | Volta pedido(s) para aguardando_separacao, reseta marcacoes |
| Voltar etapa | `POST /api/separacao/voltar-etapa` | pedido_id | Retrocede um status (embalado → separado, separado → em_separacao) |
| Cancelar separacao | `POST /api/separacao/cancelar` | pedido_ids | Cancela separacao em andamento, volta para aguardando_separacao |
| Reiniciar separacao | `POST /api/separacao/reiniciar` | pedido_ids | Reseta marcacoes (separacao_marcado=false) mantendo status em_separacao |
| Concluir separacao | `POST /api/separacao/concluir` | pedido_ids | Conclui picking normal: valida todos itens marcados, move para separado |
| Concluir OC | `POST /api/separacao/concluir-oc` | pedido_ids, operador_id | Conclui pick OC: auto-resolve compra items, enfileira execucao, adiciona tag 'pick oc' |
| Encaminhar | `POST /api/separacao/encaminhar` | pedido_id, galpao_destino_id | Encaminha pedido para outro galpao, reseta separacao |
| Marcar item | `POST /api/separacao/marcar-item` | item_id | Marca item como separacao_marcado=true via API (alternativa ao scan) |

### Pick OC — Atalho de Separacao para Itens Aguardando Compra

Quando os itens estao fisicamente disponiveis no galpao (ex.: fornecedor entregou antes), o operador pode separar diretamente sem esperar o fluxo formal de compras via conferencia.

#### Fluxo Completo com Blindagem

```mermaid
flowchart TD
    A["Operador na aba Aguardando OC<br/>Seleciona pedidos"] --> B["POST /api/separacao/iniciar<br/>com pedidos status=aguardando_compra"]

    B --> C["BLINDAGEM CHECK:<br/>Itens tem compra_status pendente?"]

    C -->|Sim - itens nao resolvidos| D["BLOQUEIA TRANSICAO<br/>Retorna erro 400<br/>Pedidos ficam em aguardando_compra"]
    D --> E["Operador deve resolver compra items ANTES<br/>Via /api/compras/conferir<br/>ou marcar como indisponivel"]
    E --> B

    C -->|Nao - todos itens ok| F["status_separacao = em_separacao<br/>Modo pick-oc ativado"]
    F --> G["Checklist com badges de compra:<br/>amarelo=aguardando, azul=comprado, verde=recebido"]

    G --> H["WAVE PICKING<br/>Operador bipa codigos de barras<br/>Itens OC transitam para recebido"]

    H --> I["POST /api/separacao/concluir-oc<br/>Endpoint especifico para Pick OC"]

    I --> J["1. Verifica todos itens marcados<br/>separacao_marcado = true"]
    J --> K["2. Auto-resolve itens OC<br/>compra_status → recebido<br/>compra_quantidade_recebida = solicitada"]
    K --> L["3. Resolve decisao final"]

    L --> M{"Galpao OC == Galpao origem?"}
    M -->|sim| N["decisao = propria"]
    M -->|nao| O["decisao = transferencia"]
    M -->|"sem OC vinculada"| N

    N --> P["4. Update pedido:<br/>status=executando<br/>status_separacao=separado<br/>Adiciona tag 'pick oc'"]
    O --> P

    P --> Q["5. Enfileira job execucao<br/>siso_fila_execucao<br/>tipo=lancar_estoque"]
    Q --> R["6. Fire-and-forget:<br/>- kickWorker<br/>- preCriarAgrupamentos<br/>- recarregarEtiquetasFaltantes<br/>- registrarEvento"]

    R --> S["Execution Worker processa:<br/>1. Lanca estoque no Tiny<br/>2. Detecta NF existente - idempotente<br/>3. Insere marcadores<br/>4. criarAgrupamentoFase1"]

    S --> T["Pedido pronto para<br/>embalagem → expedicao"]
```

#### Regras Importantes

1. **Blindagem:** Nenhum pedido com `compra_status IN ('aguardando_compra', 'comprado')` pode transicionar para `em_separacao` no fluxo normal
2. **Desbloqueio:** Operador deve resolver itens via `/api/compras/conferir` antes de tentar pick OC
3. **Auto-Resolucao:** `/api/separacao/concluir-oc` marca TODOS os itens OC como `recebido`
4. **Decisao:** Usa `galpao_id` da OC para determinar propria vs transferencia
5. **Tag:** Todos os pick OC recebem a tag `'pick oc'` para auditoria
6. **Execution:** Job fica na fila e é processado normalmente pelo execution worker

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

### Agrupamento fase 1 (antecipado)

Agrupamento fase 1 e criado assim que `nota_fiscal_id` + `chave_acesso_nf` estiverem persistidos, via `criarAgrupamentoFase1(pedidoId)`. Isso acontece no worker de aprovacao, webhook de NF, reconciliacao, ou `forcar-pendente` — bem antes do picking.

```mermaid
flowchart LR
    A["NF persistida<br/>nota_fiscal_id + chave_acesso_nf"] --> B["criarAgrupamentoFase1"]
    B --> C["1. Claim atomico<br/>2. Cria agrupamento Tiny<br/>3. Tenta concluir<br/>4. Salva expedicao_id"]
    C --> D["Pedido chega em separado<br/>com agrupamento pronto"]
    D --> E["Fast path etiqueta<br/>~200ms"]
```

### Fallback em separado (fase 2)

Para pedidos sem agrupamento em `separado` (pedidos antigos, falha na fase 1), quatro endpoints orquestram fallback de criacao + fast path de etiqueta:

```mermaid
flowchart LR
    A["Pedido em separado<br/>sem agrupamento"] --> B["preCriarAgrupamentosEmLote<br/>fallback: cria agrupamento + ZPL"]
    A2["Pedido em separado<br/>com agrupamento, sem ZPL"] --> C["recarregarEtiquetasFaltantes<br/>fast path: busca ZPL"]
    B --> D["ZPL cacheado"]
    C --> D
```

Quatro callers: `concluir`, `concluir-oc`, `retry-etiqueta`, `compras-embalagem`.

### Performance de impressao

| Caminho | Tempo | Quando acontece |
|---|---|---|
| **Fast path** | ~200ms | ZPL cacheado — maioria dos casos com agrupamento antecipado |
| **Slow path** | ~3-5s | Agrupamento nao criado previamente (pedidos antigos, falha fase 1) |
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

    aguardando_compra --> aguardando_nf: Todos itens OC recebidos via conferencia
    aguardando_compra --> aguardando_separacao: OC recebido + NF ja chegou
    aguardando_compra --> em_separacao: Operador inicia pick OC
    aguardando_compra --> embalado: Embalagem direta OC<br/>bipar-embalagem-oc
    aguardando_nf --> aguardando_separacao: Webhook NF processado
    aguardando_separacao --> em_separacao: Operador inicia picking
    em_separacao --> separado: Picking concluido via /concluir
    em_separacao --> separado: Pick OC concluido via /concluir-oc<br/>+ status=executando
    separado --> embalado: Embalagem concluida
    embalado --> expedido: Despacho realizado

    em_separacao --> aguardando_separacao: Forcar pendente / Cancelar
    em_separacao --> aguardando_compra: Forcar pendente (pick OC)
    separado --> em_separacao: Voltar etapa / Reiniciar

    note right of em_separacao: BLINDAGEM: pedidos com<br/>compra_status pendente nao<br/>transitam aqui automaticamente<br/>Operador deve resolver compra antes
```

### pedido_itens.compra_status

```mermaid
stateDiagram-v2
    [*] --> aguardando_compra: Execution worker cria demanda
    aguardando_compra --> comprado: POST /compras/comprar
    comprado --> recebido: POST /compras/receber (qty total)

    aguardando_compra --> indisponivel: POST /itens/{id}/indisponivel
    comprado --> indisponivel: POST /itens/{id}/indisponivel

    aguardando_compra --> equivalente_pendente: POST /itens/{id}/equivalente
    comprado --> equivalente_pendente: POST /itens/{id}/equivalente
    equivalente_pendente --> aguardando_compra: POST /itens/{id}/equivalente/confirmar

    aguardando_compra --> cancelamento_pendente: POST /itens/{id}/cancelamento
    comprado --> cancelamento_pendente: POST /itens/{id}/cancelamento
    cancelamento_pendente --> cancelado: POST /itens/{id}/cancelamento/confirmar

    comprado --> aguardando_compra: POST /itens/{id}/devolver

    recebido --> [*]: checkAndReleasePedidos
    cancelado --> [*]: checkAndReleasePedidos
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

---

## 11. Agrupamento Antecipado (Fase 1) — Contrato

### Principios

1. **Estoque inalterado:** `propria` e `transferencia` continuam baixando estoque na aprovacao. OC continua diferindo estoque para o Ciclo 2 (apos `compras-release`)
2. **NF estendida para OC:** `executarMarcadoresOnly` agora gera NF (sem estoque) na aprovacao, criando reserva no Tiny
3. **Agrupamento antecipado:** criado assim que `nota_fiscal_id` + `chave_acesso_nf` estiverem persistidos, via helper `criarAgrupamentoFase1`
4. **Failure isolation:** agrupamento e fire-and-forget; falha nunca causa retry de job apos estoque persistido
5. **Segunda chance:** se NF nao estiver completa no worker, webhook de NF, reconciliacao e forcar-pendente criam agrupamento depois
6. **Fallback em separado:** `preCriarAgrupamentosEmLote` + `recarregarEtiquetasFaltantes` continuam como safety net

### Entrypoints de agrupamento fase 1

```mermaid
flowchart TD
    NF["NF persistida<br/>nota_fiscal_id + chave_acesso_nf"]

    W1["Worker: executarSaidaPropria<br/>apos estoque"]
    W2["Worker: executarSaidaTransferencia<br/>apos estoque"]
    W3["Worker: executarMarcadoresOnly<br/>apos NF, antes de compra"]
    WH["Webhook NF handler<br/>apos salvar NF"]
    RC["Reconciliacao NF<br/>em webhook-processor"]
    FP1["forcar-pendente batch<br/>apos verificar chave_acesso"]
    FP2["forcar-pendente single<br/>apos verificar chave_acesso"]

    NF --> W1
    NF --> W2
    NF --> W3
    NF --> WH
    NF --> RC
    NF --> FP1
    NF --> FP2

    W1 --> H["criarAgrupamentoFase1"]
    W2 --> H
    W3 --> H
    WH --> H
    RC --> H
    FP1 --> H
    FP2 --> H

    H --> I{"Sucesso?"}
    I -->|sim| J["agrupamento_expedicao_id + expedicao_id salvos"]
    I -->|nao| K["Campos limpos, pedido apto para retry"]
```

### Contrato de re-roteamento (encaminhar)

- **NF preservada:** `nota_fiscal_id`, `chave_acesso_nf`, `url_danfe` mantidos
- **Artefatos invalidados:** `agrupamento_expedicao_id`, `expedicao_id`, `etiqueta_url`, `etiqueta_zpl`, `etiqueta_status` limpos
- Worker recria agrupamento na re-aprovacao via `criarAgrupamentoFase1`

### Matriz de validacao

| Cenario | Comportamento esperado |
|---|---|
| Aprovacao propria | Marcadores → NF → estoque → agrupamento fase 1. Estoque inalterado |
| Aprovacao transferencia | Marcadores → NF → estoque → agrupamento fase 1. Estoque inalterado |
| Aprovacao OC | Marcadores → NF (sem estoque) → agrupamento fase 1 → itens de compra |
| OC com NF pendente SEFAZ | NF gerada mas chave_acesso indisponivel. Agrupamento por segunda chance |
| OC com falha de NF | Compra continua normal. NF + agrupamento no Ciclo 2 |
| Ciclo 2 apos compras-release | Worker detecta NF existente, pula para estoque. Agrupamento provavelmente ja existe |
| Falha do helper apos estoque | Job nao retenta. Pedido coberto pelo fallback em separado |
| Pending travado | `recuperarPendingTravados` destrava rows >5 min em todas as entradas |
| NF tardia por webhook | `nf-webhook-handler` cria agrupamento fire-and-forget |
| NF tardia por forcar-pendente | Ambas rotas criam agrupamento sem bloquear resposta admin |
| Pedido com agrupamento sem etiqueta | Fast path: `recarregarEtiquetasFaltantes` busca ZPL |
| Pedido antigo sem agrupamento | Fallback: `preCriarAgrupamentosEmLote` cria agrupamento + ZPL |
| Pedido reencaminhado | NF preservada, artefatos de expedição limpos. Worker recria agrupamento |

---

## 12. Pedidos Tracking — Rastreamento Universal

Modulo de busca e rastreamento de pedidos com filtros por status, decisao, empresa e busca textual (numero, EC, cliente, SKU).

### Paginas e endpoints

| Recurso | Funcao |
|---|---|
| `/pedidos` | Lista universal: abas Pedidos/Expedidos, busca, filtros |
| `/pedidos/[id]` | Detalhe: itens + estoque por galpao, timeline, observacoes, acoes |
| `GET /api/pedidos/tracking` | Lista paginada com busca textual e filtros |
| `GET /api/pedidos/[id]/detalhe` | Dados consolidados: pedido + itens + estoques + historico + observacoes |
| `GET/POST /api/pedidos/[id]/observacoes` | Listar e adicionar observacoes |

### Controle de acesso

| Cargo | Visibilidade |
|---|---|
| `admin` | Todos os pedidos |
| `operador_cwb/sp` | Apenas pedidos do seu galpao |
| `comprador` | Apenas pedidos com decisao_final = oc |

---

## 13. Embalagem Direta OC (bipar-embalagem-oc)

Atalho para embalar pedidos OC diretamente sem picking. Operador escaneia itens na pagina de embalagem, sistema auto-resolve compra e enfileira execucao.

```mermaid
flowchart TD
    A["Aba Aguardando OC<br/>Botao 'Embalar'"] --> B["/separacao/embalagem?modo=embalagem-oc"]
    B --> C["Scan: POST /api/separacao/bipar-embalagem-oc<br/>{ sku, pedido_ids[], quantidade }"]
    C --> D["Busca pedido mais antigo<br/>com SKU pendente (oldest-first)"]
    D --> E["Incrementa quantidade_bipada<br/>(optimistic lock)"]
    E --> F{"Todos itens do pedido<br/>bipado_completo?"}
    F -->|nao| C
    F -->|sim| G["1. Auto-resolve compra: recebido<br/>2. Resolve decisao (propria/transferencia)<br/>3. status → executando, embalado<br/>4. Enfileira lancar_estoque<br/>5. Imprime etiqueta<br/>6. Tag 'embalagem direta'"]
    G --> H["Pedido pronto para expedicao"]
```

### Transicao de estado

`aguardando_compra` → `embalado` (pula picking inteiro)
