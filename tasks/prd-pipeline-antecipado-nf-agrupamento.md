# PRD: Agrupamento Antecipado com Estoque Mantido na Aprovacao

## 1. Introducao/Overview

O fluxo atual do SISO tem um comportamento que queremos preservar:

- pedidos `propria` e `transferencia` ja baixam estoque no fluxo de aprovacao

Essa decisao continua valida porque evita aprovacao sobre saldo "fantasma". Em outras palavras: o estoque segue sendo comprometido cedo para que novos pedidos nao enxerguem disponibilidade que ja foi consumida por um pedido aprovado.

O problema que continua em aberto nao e o estoque. O problema e o agrupamento:

- hoje o agrupamento so e criado quando o pedido chega em `separado`
- isso posterga a criacao da expedicao
- isso atrasa a obtencao de etiqueta/ZPL
- isso concentra muito trabalho no momento final da separacao

Portanto, este Ralph deixa de mover o estoque para `separado`. O novo escopo e:

- **manter** o desconto de estoque como esta hoje para `propria` e `transferencia`
- **estender** a geracao de NF para pedidos `oc` na aprovacao (sem baixa de estoque), para que a NF exista cedo e o agrupamento possa ser criado antes do pick OC
- **antecipar** a criacao do agrupamento fase 1 assim que a NF estiver persistida, em **todos** os fluxos (propria, transferencia e oc)
- fazer `separado` virar principalmente o momento de buscar etiqueta/ZPL, com fallback para criar agrupamento apenas quando ele ainda nao existir

**Fluxo alvo:**

- **Aprovacao `propria`/`transferencia`:** marcadores + NF + estoque + tentativa de agrupamento fase 1
- **Aprovacao `oc`:** marcadores + NF (sem estoque) + tentativa de agrupamento fase 1 + resolucao de itens de compra. Estoque e diferido para o Ciclo 2 (apos compras-release)
- **Separacao:** picking
- **Pick OC:** bipar itens → concluir → etiqueta pronta (fast path, agrupamento ja existe)
- **Separado:** fast path para etiqueta/ZPL quando agrupamento ja existir; fallback cria agrupamento quando necessario

---

## 2. Goals

- Preservar o desconto de estoque atual em `propria` e `transferencia`
- Nao criar novo fluxo de estoque em `separado`
- Estender a geracao de NF para pedidos `oc` na aprovacao (sem baixa de estoque), para que NF + agrupamento existam antes do pick OC
- Criar agrupamento fase 1 assim que `nota_fiscal_id` e `chave_acesso_nf` estiverem persistidos, em todos os tres fluxos (propria, transferencia e oc)
- Reaproveitar o mesmo mecanismo de agrupamento a partir de worker, webhook de NF, reconciliacao e rotas manuais de `forcar-pendente`
- Isolar falhas de agrupamento do job de estoque no worker para evitar retry falso depois de baixa ja persistida
- Tornar a recuperacao de `pending` reutilizavel fora do fluxo de `separado`
- Manter a divisao de responsabilidades entre fallback de criacao de agrupamento e fast path de recuperacao de etiqueta
- Reduzir o tempo para obtencao de etiqueta em `separado`
- Transformar o pick OC em: bipar itens → concluir → etiqueta pronta (fast path)
- Evitar duplicidade de agrupamento sob concorrencia

---

## 3. User Stories

### US-001: Criar helper compartilhado de agrupamento fase 1

**Descricao:** Como desenvolvedor, quero um helper reutilizavel que crie agrupamento fase 1 para um pedido assim que a NF estiver persistida.

**Acceptance Criteria:**
- [ ] Criar `criarAgrupamentoFase1(pedidoId)` em modulo compartilhado
- [ ] O helper reconsulta o pedido e so prossegue quando `nota_fiscal_id` e `chave_acesso_nf` estiverem preenchidos
- [ ] O helper verifica idempotencia: se ja existir `agrupamento_expedicao_id` valido, retorna sem recriar
- [ ] O helper reaproveita ou extrai o padrao atomico ja existente do `agrupamento-service` (`pending` + `siso_claim_pedidos_para_agrupamento`), em vez de criar um guard concorrente
- [ ] Se o claim atomico for endurecido para a fase 1, ele nunca grava `pending` antes de `nota_fiscal_id` + `chave_acesso_nf` estarem persistidos
- [ ] A semantica da fase 1 fica explicita: criar agrupamento, tentar `concluirAgrupamento` no mesmo estilo nao-fatal ja usado hoje, depois `obterAgrupamento` para descobrir e salvar `expedicao_id`
- [ ] O helper NAO busca etiqueta/ZPL nem baixa ZPL
- [ ] A recuperacao de `pending` travado e extraida ou tornada reutilizavel fora de `preCriarAgrupamentosEmLote`, para que a fase 1 tambem consiga destravar retries cedo
- [ ] Em sucesso, salva `agrupamento_expedicao_id` e `expedicao_id`
- [ ] Em falha, deixa o pedido apto para retry futuro
- [ ] Typecheck passes

### US-002: Chamar geracao de NF e agrupamento fase 1 em todos os fluxos do worker

**Descricao:** Como desenvolvedor, quero que todos os fluxos do worker — incluindo OC — gerem NF e criem agrupamento fase 1 logo apos a persistencia da NF. OC ganha geracao de NF na aprovacao mas NAO ganha baixa de estoque.

**Acceptance Criteria:**
- [ ] `executarSaidaPropria` chama `criarAgrupamentoFase1` apos `enriquecerDadosNf`
- [ ] `executarSaidaTransferencia` chama `criarAgrupamentoFase1` apos `enriquecerDadosNf`
- [ ] A chamada do helper fica failure-isolated do job do worker: erro de agrupamento NAO pode reencolar/reprocessar o job depois de `estoque_lancado` ou `estoque_saida_lancada` ja terem sido persistidos
- [ ] Se a fase 1 ainda nao puder rodar porque a NF nao ficou persistida por completo, o worker conclui normalmente e deixa o pedido para os entrypoints de segunda chance
- [ ] O desconto de estoque em `propria` e `transferencia` permanece exatamente como hoje
- [ ] `executarMarcadoresOnly` ganha geracao de NF (via `gerarNotaFiscalPedido`, idempotente) e `enriquecerDadosNf` apos marcadores, seguido de chamada a `criarAgrupamentoFase1`
- [ ] `executarMarcadoresOnly` NAO ganha baixa de estoque — estoque de OC continua diferido para o Ciclo 2 (worker apos `compras-release`)
- [ ] Falha na geracao de NF em `executarMarcadoresOnly` NAO bloqueia a resolucao de itens de compra: se NF falhar, o fluxo OC (aguardando_compra + itens) continua normalmente
- [ ] Geracao de NF + `enriquecerDadosNf` + `criarAgrupamentoFase1` rodam ANTES de `resolveCompraItemIds`, dentro de um unico try/catch que nao propaga para a resolucao de compra
- [ ] `enriquecerDadosNf` em `executarMarcadoresOnly` NAO deve disparar transicao de `status_separacao` (o guard condicional `eq("status_separacao", "aguardando_nf")` em `enriquecerDadosNf` protege, pois o pedido nao foi setado para `aguardando_nf` neste ponto)
- [ ] Quando `executarMarcadoresOnly` detecta `compraDemandas.length === 0` e redireciona para `propria`, o `status_separacao` deve ser `aguardando_separacao` (nao `aguardando_nf`) quando NF ja existe
- [ ] Se NF for gerada mas `chave_acesso_nf` ainda nao estiver disponivel (NF pendente autorizacao SEFAZ), `executarMarcadoresOnly` prossegue para resolucao de compra e deixa agrupamento para entrypoints de segunda chance (webhook, forcar-pendente)
- [ ] O worker do Ciclo 2 (apos `compras-release`) detecta NF existente via idempotencia de `gerarNotaFiscalPedido` e pula direto para baixa de estoque
- [ ] Comentarios/docstrings do worker passam a explicitar que este Ralph muda timing de NF para OC e timing de agrupamento para todos os fluxos, nao timing de estoque
- [ ] Typecheck passes

### US-003: Dar segunda chance de agrupamento quando a NF persistir fora do timing do worker

**Descricao:** Como sistema, quero que pedidos cuja NF so ficou persistida depois tenham uma segunda chance de criar agrupamento.

**Acceptance Criteria:**
- [ ] `nf-webhook-handler.ts` chama `criarAgrupamentoFase1` apos salvar `nota_fiscal_id` + `chave_acesso_nf`
- [ ] A chamada so ocorre quando ambos os campos estiverem persistidos
- [ ] O webhook nao bloqueia resposta por causa do agrupamento
- [ ] O bloco de reconciliacao de NF em `webhook-processor.ts` tambem chama `criarAgrupamentoFase1`
- [ ] A reconciliacao deixa de jogar o pedido para `pendente` e preserva a semantica correta de `aguardando_nf` -> `aguardando_separacao`
- [ ] `src/app/api/separacao/forcar-pendente/route.ts` chama `criarAgrupamentoFase1` apos persistir `chave_acesso_nf`
- [ ] `src/app/api/separacao/[pedidoId]/forcar-pendente/route.ts` chama `criarAgrupamentoFase1` apos persistir `chave_acesso_nf`
- [ ] As rotas de `forcar-pendente` preservam sua resposta de admin e nao falham a acao por causa de erro no Tiny ao criar agrupamento
- [ ] O mesmo mecanismo de idempotencia protege worker, webhook, reconciliacao e `forcar-pendente`
- [ ] Typecheck passes

### US-004: Preservar a divisao entre criar agrupamento e recuperar etiqueta em `separado`

**Descricao:** Como desenvolvedor, quero que o fluxo de `separado` preserve a divisao atual entre fallback de criacao de agrupamento e fast path de recuperacao de etiqueta, deixando essa orquestracao explicita e consistente.

**Acceptance Criteria:**
- [ ] `preCriarAgrupamentosEmLote` continua sendo a primitiva de fallback para pedidos sem `agrupamento_expedicao_id`
- [ ] `recarregarEtiquetasFaltantes` continua sendo a primitiva de fast path para pedidos com `agrupamento_expedicao_id` valido e `etiqueta_zpl` ausente
- [ ] `concluir`, `concluir-oc`, `retry-etiqueta` e `compras-embalagem` todos orquestram fallback de criacao e fast path de etiqueta em ordem deliberada, sem duplicar responsabilidades em varios pontos
- [ ] `concluir-oc` ganha chamada a `recarregarEtiquetasFaltantes` (fire-and-forget) ao lado de `preCriarAgrupamentosEmLote`, para que pedidos pick OC com agrupamento pre-existente tenham ZPL cacheado no momento do concluir
- [ ] O fallback so tenta criar agrupamento quando a NF estiver persistida
- [ ] Pedidos antigos com agrupamento ja salvo e sem etiqueta continuam pelo fast path sem recriar agrupamento por padrao
- [ ] O processamento continua idempotente para pedidos antigos sem agrupamento e para retries
- [ ] Typecheck passes

### US-005: Explicitar a invalidação de artefatos em re-roteamento

**Descricao:** Como desenvolvedor, quero que o fluxo de `encaminhar` preserve explicitamente a NF e limpe os artefatos de expedição para que o agrupamento antecipado continue seguro sob re-roteamento.

**Acceptance Criteria:**
- [ ] `src/app/api/separacao/encaminhar/route.ts` continua preservando `nota_fiscal_id` e `chave_acesso_nf` ao reencaminhar
- [ ] O payload de reset limpa explicitamente `agrupamento_expedicao_id`, `expedicao_id`, `etiqueta_url`, `etiqueta_zpl` e `etiqueta_status`
- [ ] Comentarios e/ou logs da rota passam a explicitar que o re-roteamento invalida artefatos de expedição, mas nao invalida a NF
- [ ] O comportamento de estorno de estoque permanece inalterado
- [ ] Typecheck passes

### US-006: Atualizar documentacao e matriz de validacao

**Descricao:** Como equipe tecnica, queremos documentar claramente que este Ralph mexe em agrupamento, mas nao no estoque.

**Acceptance Criteria:**
- [ ] Atualizar `docs/architecture-and-flows.md`, `docs/api-reference-complete.md` e `docs/fluxos-siso.md`
- [ ] Documentar explicitamente que `propria` e `transferencia` continuam baixando estoque na aprovacao
- [ ] Documentar que o novo comportamento e: agrupamento fase 1 assim que a NF persistir, via helper compartilhado e guardado
- [ ] Documentar que a integracao do worker e failure-isolated do sucesso de estoque e que os caminhos de NF tardia incluem webhook, reconciliacao e as duas rotas de `forcar-pendente`
- [ ] Documentar fast path e fallback em `separado` sem colapsar a divisao atual entre criacao de agrupamento e recuperacao de etiqueta
- [ ] Definir matriz minima executavel de validacao cobrindo: falha do helper apos baixa de estoque, recuperacao de `pending` travado, NF tardia por webhook, NF tardia por `forcar-pendente`, pedido antigo com agrupamento existente mas sem etiqueta, e pedido reencaminhado apos agrupamento antecipado
- [ ] Typecheck passes

---

## 4. Functional Requirements

**Estoque:**
- FR-1: `executarSaidaPropria` continua baixando estoque na aprovacao
- FR-2: `executarSaidaTransferencia` continua baixando estoque na aprovacao
- FR-3: Nao sera criado novo job de estoque em `separado`
- FR-4: `concluir` e `concluir-oc` nao mudam semantica de estoque neste Ralph
- FR-4b: `executarMarcadoresOnly` NAO ganha baixa de estoque — estoque de OC continua diferido para o Ciclo 2

**NF para OC:**
- FR-4c: `executarMarcadoresOnly` ganha geracao de NF (via `gerarNotaFiscalPedido`, idempotente) apos marcadores
- FR-4d: `executarMarcadoresOnly` chama `enriquecerDadosNf` apos geracao de NF para obter `chave_acesso_nf` se ja autorizada
- FR-4e: Falha de NF em `executarMarcadoresOnly` nao bloqueia a resolucao de itens de compra
- FR-4e2: Geracao de NF + `enriquecerDadosNf` + `criarAgrupamentoFase1` rodam ANTES de `resolveCompraItemIds`, dentro de try/catch isolado
- FR-4e3: `enriquecerDadosNf` em `executarMarcadoresOnly` nao dispara transicao de status (guard condicional protege)
- FR-4e4: Quando OC nao tem faltas reais e redireciona para propria, `status_separacao` deve ser `aguardando_separacao` (nao `aguardando_nf`) quando NF ja existe
- FR-4f: O worker do Ciclo 2 (apos `compras-release`) detecta NF existente via idempotencia e pula para baixa de estoque
- FR-4g: A NF gerada na aprovacao de OC cria reserva no Tiny que persiste ate o Ciclo 2 baixar estoque

**Agrupamento fase 1:**
- FR-5: O agrupamento fase 1 so pode rodar com `nota_fiscal_id` e `chave_acesso_nf` persistidos
- FR-6: O agrupamento fase 1 deve ser idempotente
- FR-7: O agrupamento fase 1 deve ser seguro sob concorrencia entre worker, webhook, reconciliacao e `forcar-pendente`
- FR-8: O agrupamento fase 1 inclui criar agrupamento, tentar concluir, obter detalhes e salvar `agrupamento_expedicao_id` e `expedicao_id`
- FR-9: O agrupamento fase 1 nao busca etiqueta/ZPL
- FR-10: Se o agrupamento fase 1 usar o sentinel `pending`, a recuperacao de `pending` travado precisa estar disponivel nos entrypoints de fase 1 e nao apenas no fluxo de `separado`
- FR-11: Falha de agrupamento no worker nao pode reprocessar o job depois que a baixa de estoque ja foi persistida

**Agrupamento fase 2 / etiqueta:**
- FR-12: `preCriarAgrupamentosEmLote` permanece responsavel pelo fallback de criacao quando o agrupamento estiver ausente
- FR-13: `recarregarEtiquetasFaltantes` permanece responsavel pelo fast path de etiqueta quando o agrupamento ja existir
- FR-13b: `concluir-oc` ganha chamada a `recarregarEtiquetasFaltantes` (fire-and-forget) para que pick OC com agrupamento pre-existente tenha ZPL cacheado
- FR-14: Pedidos antigos sem agrupamento continuam cobertos pelo fallback

**Fluxos cobertos:**
- FR-15: `propria`, `transferencia` e `oc` ganham agrupamento fase 1 no worker de aprovacao (oc ganha tambem geracao de NF)
- FR-16: pedidos cuja NF persistir depois ganham agrupamento fase 1 por webhook, reconciliacao ou `forcar-pendente`
- FR-17: o modulo de compras nao muda neste Ralph; o pick OC se beneficia porque NF + agrupamento ja existem quando o operador bipa os itens

---

## 5. Non-Goals (Out of Scope)

- Mover o desconto de estoque para `separado`
- Criar `stock-posting-service.ts`
- Criar novo tipo de job para estoque
- Adicionar baixa de estoque em `executarMarcadoresOnly` (estoque de OC continua no Ciclo 2)
- Simplificar `compras-release`
- Mudar o modulo de compras (comprar/receber/conferencia)
- Adicionar icones de pipeline na UI
- Criar novos campos de status de estoque

---

## 6. Technical Considerations

### Arquivos impactados

| Arquivo | Mudanca |
|---|---|
| `src/lib/execution-worker.ts` | Adicionar geracao de NF em `executarMarcadoresOnly` + chamada de agrupamento fase 1 apos NF persistida em `propria`, `transferencia` e `oc` |
| `src/lib/agrupamento-service.ts` | Preservar a divisao entre fallback de criacao e fast path de etiqueta, endurecendo os gates de NF persistida |
| `src/lib/nf-webhook-handler.ts` | Chamar agrupamento fase 1 apos persistencia de NF |
| `src/lib/webhook-processor.ts` | Corrigir reconciliacao e chamar agrupamento fase 1 |
| `src/app/api/separacao/forcar-pendente/route.ts` | Dar segunda chance de agrupamento quando a NF for autorizada manualmente em lote |
| `src/app/api/separacao/[pedidoId]/forcar-pendente/route.ts` | Dar segunda chance de agrupamento quando a NF for autorizada manualmente por pedido |
| `src/app/api/separacao/concluir/route.ts` | Preservar a orquestracao create-fallback + label-fast-path |
| `src/app/api/separacao/concluir-oc/route.ts` | Adicionar chamada a `recarregarEtiquetasFaltantes` fire-and-forget para completar o fast path do pick OC |
| `src/app/api/separacao/retry-etiqueta/route.ts` | Preservar a orquestracao create-fallback + label-fast-path |
| `src/lib/compras-embalagem.ts` | Preservar a orquestracao create-fallback + label-fast-path em embalagem direta |
| `supabase/migrations/*` | Reaproveitar/ajustar o RPC de claim atomico se o helper de fase 1 precisar endurecer o gate de NF persistida |
| `src/app/api/separacao/encaminhar/route.ts` | Validar/ajustar limpeza de artefatos de agrupamento apos re-roteamento |
| `docs/*` | Atualizar documentacao do fluxo corrigido |

### Dependencias

- Tiny API v3: `criarAgrupamento`, `concluirAgrupamento`, `obterAgrupamento`, `obterEtiquetasExpedicao`, `gerarNotaFiscal`
- Mecanismo atual de NF: `gerarNotaFiscalPedido` (idempotente via `nota_fiscal_id`), `enriquecerDadosNf`, webhook de NF e reconciliacao
- Mecanismo atual de estoque em `propria` e `transferencia` permanece inalterado
- `gerarNotaFiscalPedido` ja e idempotente: o Ciclo 2 detecta NF existente e pula direto para estoque
- Guard atual de agrupamento: RPC `siso_claim_pedidos_para_agrupamento` + sentinel `agrupamento_expedicao_id='pending'`
- Fast path atual de etiqueta: `recarregarEtiquetasFaltantes`

### Riscos

- **Concorrencia entre worker, webhook, reconciliacao e `forcar-pendente`**: precisa de guard atomico para nao criar agrupamento duplicado
- **Retry falso no worker apos baixa de estoque**: o helper de agrupamento precisa ser failure-isolated para nao reencolar um job que ja persistiu estoque
- **`pending` travado antes do separado**: se a fase 1 reutilizar o sentinel atual, a recuperacao precisa existir antes do fluxo de `separado`
- **NF ainda nao autorizada no momento do worker**: webhook, reconciliacao e `forcar-pendente` precisam cobrir a segunda chance
- **Pedidos antigos sem agrupamento**: fallback em `separado` continua sendo obrigatorio
- **Pedidos com agrupamento existente e sem etiqueta**: a fase 2 precisa continuar usando o fast path atual sem recriar agrupamento por padrao
- **Re-roteamento apos agrupamento antecipado**: precisa continuar limpando artefatos a jusante sem invalidar NF
- **Reserva de estoque OC no Tiny**: a NF gerada na aprovacao cria reserva que persiste ate o Ciclo 2. Se o pedido ficar semanas em compras, a reserva fica la. Comportamento identico ao que ja acontece com propria/transferencia
- **Falha de NF em OC**: se `gerarNotaFiscalPedido` falhar para OC, o fluxo de compras continua normalmente e a NF sera gerada no Ciclo 2. Nao e bloqueante
- **NF orfao em cancelamento de OC**: se um pedido OC for cancelado durante compras, a NF + reserva no Tiny ficam orfaos. O Tiny tolera NFs orfaos (nao causam efeitos colaterais alem de reserva fantasma no saldo). Aceito como divida tecnica neste Ralph — mecanismo de limpeza pode ser planejado como follow-up se o volume de cancelamentos justificar
- **Side-effect de `enriquecerDadosNf` no OC**: a funcao pode setar `status_separacao = "aguardando_separacao"` via update condicional, mas o guard `eq("status_separacao", "aguardando_nf")` protege porque o pedido OC nao passa por `aguardando_nf` antes da resolucao de compra

---

## 7. Rollout and Validation

### Fase 1

- Criar helper compartilhado de agrupamento fase 1
- Ligar helper no worker de `propria` e `transferencia`
- Adicionar geracao de NF em `executarMarcadoresOnly` + ligar helper

### Fase 2

- Ligar helper no webhook de NF, na reconciliacao e nas rotas de `forcar-pendente`

### Fase 3

- Preservar e explicitar a orquestracao entre `preCriarAgrupamentosEmLote` e `recarregarEtiquetasFaltantes`
- Validar comportamento de `encaminhar`
- Atualizar documentacao final

### Matriz minima de validacao

- `propria`: aprovacao gera NF, baixa estoque como hoje e cria agrupamento fase 1
- `transferencia`: aprovacao gera NF, baixa estoque como hoje e cria agrupamento fase 1
- `oc`: aprovacao gera NF (sem estoque), cria agrupamento fase 1. Pick OC encontra etiqueta pronta via fast path
- `oc` com NF pendente SEFAZ: aprovacao gera NF mas `chave_acesso_nf` nao disponivel; agrupamento criado via segunda chance (webhook ou forcar-pendente)
- `oc` com falha de NF: fluxo de compras continua normalmente; NF e agrupamento criados no Ciclo 2
- Ciclo 2 (apos compras-release): worker detecta NF existente e pula para baixa de estoque sem recriar NF
- falha do helper apos baixa de estoque: o job nao volta ao retry falso nem reaplica estoque
- NF tardia: webhook/reconciliacao criam agrupamento sem duplicidade
- NF tardia manual: `forcar-pendente` cria agrupamento sem quebrar a resposta administrativa
- `pending` travado: fase 1 e/ou separado conseguem recuperar e retentar o pedido
- pedido com agrupamento existente e sem etiqueta: fast path recupera etiqueta sem recriar agrupamento
- pedido antigo sem agrupamento: `separado` continua criando agrupamento e etiqueta pelo fallback
- pedido reencaminhado: NF preservada e agrupamento/etiqueta invalidados corretamente

---

## 8. Success Metrics

- Pedidos `propria`, `transferencia` e `oc` passam a chegar em `separado` com agrupamento ja criado na maioria dos casos
- Pick OC se resume a bipar itens e emitir etiqueta (agrupamento ja existe)
- Tempo medio para obter etiqueta em `separado` cai porque a maioria dos pedidos entra pelo fast path
- Zero regressao no momento de baixa de estoque
- Zero duplicidade de agrupamento para o mesmo pedido
- Pedidos antigos sem agrupamento continuam sendo resolvidos pelo fallback

---

## 9. Open Questions

- Se o helper de fase 1 exigir endurecer o claim atomico atual, vale generalizar o RPC existente ou criar uma variante dedicada?
- Vale registrar algum estado adicional de agrupamento para auditoria, ou `agrupamento_expedicao_id` + logs ja bastam?
- Depois deste Ralph, um retry channel dedicado de agrupamento ainda vale como segundo passo, mesmo que a primeira entrega use failure isolation + segunda chance pelos entrypoints existentes?
- A reserva de estoque criada pela NF de OC na aprovacao pode causar problemas se o pedido ficar muitas semanas em compras? O comportamento e identico ao de propria/transferencia, mas o tempo pode ser maior para OC
