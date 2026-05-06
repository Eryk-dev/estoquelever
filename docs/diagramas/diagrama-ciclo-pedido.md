# Ciclo de Vida Completo de um Pedido

Um fluxograma com todos os caminhos possíveis de um pedido dentro do SISO.

```mermaid
flowchart TD
    %% ════════════════════════════════════════════
    %% ENTRADA
    %% ════════════════════════════════════════════
    WH(["Webhook Tiny ERP"])
    WH --> IDENT["Identifica empresa por CNPJ<br/>Enriquece estoque multi-empresa"]
    IDENT --> DCALC{"Qual galpão<br/>cobre os itens?"}

    %% ════════════════════════════════════════════
    %% DECISÃO
    %% ════════════════════════════════════════════
    DCALC -->|"Origem cobre 100%"| PROPRIA["Decisão: PROPRIA"]
    DCALC -->|"Outro galpão cobre 100%"| TRANSF["Decisão: TRANSFERENCIA"]
    DCALC -->|"Nenhum cobre tudo"| OC["Decisão: OC"]

    PROPRIA --> AUTOAPROVA["Auto-aprovação<br/>status = executando"]
    TRANSF --> PAINEL["Painel operador /siso<br/>status = pendente"]
    OC --> PAINEL

    PAINEL --> DPAINEL{"Operador decide"}
    DPAINEL -->|"Aprova"| MANUAL_EXEC["status = executando"]
    DPAINEL -->|"Cancela no Tiny"| CANCELADO

    AUTOAPROVA --> WORKER
    MANUAL_EXEC --> WORKER

    %% ════════════════════════════════════════════
    %% EXECUTION WORKER
    %% ════════════════════════════════════════════
    WORKER["Execution Worker<br/>insere marcadores, gera NF"]

    WORKER --> DTIPO{"Tipo da decisão?"}

    DTIPO -->|"propria"| W_PROPRIA["Lança estoque<br/>na empresa origem"]
    DTIPO -->|"transferencia"| W_TRANSF["Movimenta estoque<br/>cross-empresa"]
    DTIPO -->|"oc"| W_OC["Marca itens como<br/>oc_pendente"]

    W_PROPRIA --> DNF{"NF já autorizada?"}
    W_TRANSF --> DNF

    W_OC --> VALIDACAO_OC

    WORKER --> WERR{"Worker falhou?"}
    WERR -->|"Retry com backoff"| WORKER
    WERR -->|"Max retries"| ERRO(["ERRO"])

    %% ════════════════════════════════════════════
    %% NOTA FISCAL
    %% ════════════════════════════════════════════
    DNF -->|"Sim"| AGUARD_SEP
    DNF -->|"Não"| AGUARD_NF

    AGUARD_NF["aguardando_nf"]
    AGUARD_NF -->|"Webhook NF autorizada"| AGUARD_SEP
    AGUARD_NF -->|"Worker detecta NF pronta"| AGUARD_SEP
    AGUARD_NF -->|"Admin força verificação"| AGUARD_SEP

    %% ════════════════════════════════════════════
    %% VALIDAÇÃO OC
    %% ════════════════════════════════════════════
    VALIDACAO_OC["validacao_oc<br/>Operador confere cada item"]

    VALIDACAO_OC --> DOC{"Item existe<br/>fisicamente?"}
    DOC -->|"Encontrei (todos)"| AGUARD_SEP
    DOC -->|"Esgotado (precisa comprar)"| AGUARD_COMPRA
    DOC -->|"Misto"| MISTO["Encontrados: marcados<br/>Esgotados: p/ compra"]
    MISTO --> AGUARD_COMPRA

    %% ════════════════════════════════════════════
    %% COMPRAS
    %% ════════════════════════════════════════════
    AGUARD_COMPRA["aguardando_compra"]

    AGUARD_COMPRA --> DCOMPRA{"Fluxo de compra"}
    DCOMPRA -->|"Normal"| COMPRADO["comprado<br/>Comprador compra"]
    DCOMPRA -->|"Indisponível"| INDISP["indisponivel"]
    DCOMPRA -->|"Propor equivalente"| EQUIV["equivalente_pendente"]
    DCOMPRA -->|"Propor cancelamento"| CXPEND["cancelamento_pendente"]

    COMPRADO --> RECEBIDO["recebido<br/>Conferência OK"]

    EQUIV -->|"Confirmar equivalente<br/>novo SKU"| AGUARD_COMPRA
    CXPEND -->|"Confirmar cancelamento"| CXD["cancelado"]

    INDISP --> DTERMINAL{"Todos itens<br/>do pedido terminais?"}
    CXD --> DTERMINAL
    DTERMINAL -->|"Sim"| CANCELADO
    DTERMINAL -->|"Não"| RELEASE

    RECEBIDO --> RELEASE{"Todos itens<br/>resolvidos?"}
    RELEASE -->|"Sim + NF existe"| AGUARD_SEP
    RELEASE -->|"Sim + sem NF"| AGUARD_NF

    %% ════════════════════════════════════════════
    %% SEPARAÇÃO
    %% ════════════════════════════════════════════
    AGUARD_SEP["aguardando_separacao"]
    AGUARD_SEP -->|"Operador inicia picking"| EM_SEP

    EM_SEP["em_separacao<br/>Bipa cada item (barcode)"]

    EM_SEP --> DCONCLUIR{"Concluir separação"}
    DCONCLUIR -->|"Todos itens OK"| SEPARADO
    DCONCLUIR -->|"Itens normais OK<br/>mas compras pendentes"| AGUARD_COMPRA
    DCONCLUIR -->|"Pick OC concluído<br/>(auto-resolve compras)"| SEPARADO

    %% ════════════════════════════════════════════
    %% EMBALAGEM & EXPEDIÇÃO
    %% ════════════════════════════════════════════
    SEPARADO["separado"]
    SEPARADO -->|"Bipa embalagem"| EMBALADO["embalado<br/>Imprime etiqueta ZPL"]
    EMBALADO -->|"Confirma expedição"| EXPEDIDO(["EXPEDIDO"])

    %% ════════════════════════════════════════════
    %% CANCELAMENTO (webhook a qualquer momento)
    %% ════════════════════════════════════════════
    CANCELADO(["CANCELADO"])
    WH_CANCEL(["Webhook cancelamento<br/>Tiny cancela pedido"])
    WH_CANCEL -.-> CANCELADO

    %% ════════════════════════════════════════════
    %% AÇÕES REVERSAS
    %% ════════════════════════════════════════════
    EM_SEP -->|"Cancelar separação<br/>(sem compras)"| AGUARD_SEP
    EM_SEP -->|"Cancelar separação<br/>(com compras)"| AGUARD_COMPRA
    EM_SEP -->|"Cancelar separação<br/>(oc_pendente)"| VALIDACAO_OC

    EM_SEP -->|"Encaminhar p/<br/>outro galpão"| PAINEL
    AGUARD_SEP -->|"Encaminhar p/<br/>outro galpão"| PAINEL

    EM_SEP -->|"SKU esgotado → OC"| AGUARD_COMPRA
    AGUARD_SEP -->|"SKU esgotado → OC"| AGUARD_COMPRA

    EM_SEP -->|"SKU esgotado → encaminhar"| AGUARD_SEP
    AGUARD_SEP -->|"SKU esgotado → encaminhar<br/>(novo galpão)"| AGUARD_SEP

    SEPARADO -->|"Admin voltar etapa"| EM_SEP
    EMBALADO -->|"Admin voltar etapa"| SEPARADO

    %% ════════════════════════════════════════════
    %% ESTILOS
    %% ════════════════════════════════════════════
    style WH fill:#3b82f6,color:#fff
    style EXPEDIDO fill:#22c55e,color:#fff
    style CANCELADO fill:#ef4444,color:#fff
    style ERRO fill:#ef4444,color:#fff
    style WH_CANCEL fill:#ef4444,color:#fff

    style PAINEL fill:#f59e0b20,stroke:#f59e0b
    style AUTOAPROVA fill:#22c55e20,stroke:#22c55e
    style WORKER fill:#6366f120,stroke:#6366f1

    style VALIDACAO_OC fill:#f59e0b20,stroke:#f59e0b
    style AGUARD_NF fill:#06b6d420,stroke:#06b6d4
    style AGUARD_SEP fill:#8b5cf620,stroke:#8b5cf6
    style EM_SEP fill:#8b5cf620,stroke:#8b5cf6
    style SEPARADO fill:#22c55e20,stroke:#22c55e
    style EMBALADO fill:#14b8a620,stroke:#14b8a6

    style AGUARD_COMPRA fill:#f9731620,stroke:#f97316
    style COMPRADO fill:#f9731620,stroke:#f97316
    style RECEBIDO fill:#22c55e20,stroke:#22c55e
    style INDISP fill:#ef444420,stroke:#ef4444
    style EQUIV fill:#f59e0b20,stroke:#f59e0b
    style CXPEND fill:#ef444420,stroke:#ef4444
    style CXD fill:#ef444420,stroke:#ef4444
```

### Legenda

| Cor | Significado |
|---|---|
| Azul escuro | Entrada/saída do sistema |
| Roxo | Separação (picking) |
| Verde | Conclusão / sucesso |
| Laranja | Compras (OC) |
| Amarelo | Aguardando decisão / validação |
| Ciano | Aguardando NF |
| Vermelho | Erro / cancelamento |

### Notas

- **Webhook cancelamento** pode atingir o pedido em qualquer status (pendente, executando, ou qualquer status_separacao)
- **Admin voltar-etapa** pode mover entre qualquer status_separacao (não mostrado por completo para manter legibilidade)
- **Reiniciar** reseta progress de picks (em_separacao) ou bips (separado) sem mudar o status
- **Forçar pendente** = admin verifica NF no Tiny e força aguardando_nf → aguardando_separacao
