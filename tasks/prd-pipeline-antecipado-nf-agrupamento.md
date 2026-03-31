# PRD: Pipeline Antecipado de NF + Agrupamento

## 1. Introducao/Overview

Hoje, pedidos OC (ordem de compra) nao geram nota fiscal nem agrupamento na aprovacao — so inserem marcadores. A NF e o agrupamento so sao criados muito depois, quando os itens sao recebidos e o pedido e liberado. Isso causa atraso na separacao e na obtencao de etiquetas.

Alem disso, o lancamento de estoque acontece cedo demais (na aprovacao, antes da separacao), o que pode causar inconsistencias se o pedido travar no meio do fluxo.

Esta mudanca antecipa a geracao de NF e a fase 1 do agrupamento para o momento da aprovacao (especialmente para OC), posterga o lancamento de estoque para o momento correto (quando o item e separado), e deixa a fase 2 da etiqueta/ZPL para depois. Um sistema visual de icones de progresso no estilo do Tiny ERP permite que operadores acompanhem o estado de cada etapa do pipeline.

**Problema:** Pedidos OC chegam na separacao sem NF e sem agrupamento, exigindo que tudo seja criado na hora — gerando latencia e complexidade.

**Solucao:** Antecipar NF + agrupamento fase 1 na aprovacao, rodar agrupamento somente apos a NF estar persistida no pedido, postergar lancamento de estoque para "separado", e exibir progresso visual por icones.

---

## 2. Goals

- Pedidos OC geram NF na aprovacao, eliminando a espera posterior
- Pedidos OC tem agrupamento fase 1 criado + concluido + `expedicao_id` salvo na aprovacao
- Pedidos OC NAO baixam/cacham ZPL na aprovacao; isso fica para a fase 2
- Toda a plataforma so roda agrupamento quando a NF estiver persistida no pedido (`nota_fiscal_id` + `chave_acesso_nf`)
- Lancamento de estoque (`lancarEstoqueNota`) acontece somente quando o item atinge status "separado" (para todas as decisoes)
- Para transferencia, ao chegar em "separado", o sistema limpa a reserva na origem e faz os movimentos de estoque corretos entre origem e empresa que enviou fisicamente
- Para propria/transferencia, manter agrupamento na separacao (como hoje)
- Pedidos existentes em `aguardando_compra` sem NF recebem backfill retroativo
- Operadores visualizam icones de progresso do pipeline (NF > Agrupamento > Estoque > Etiqueta) nos cards de pedido
- Nenhuma regressao nos fluxos existentes de propria/transferencia

---

## 3. User Stories

### US-001: Geracao de NF para pedidos OC na aprovacao

**Descricao:** Como operador, quero que pedidos OC gerem nota fiscal automaticamente na aprovacao, para que a NF ja esteja pronta quando eu for separar.

**Acceptance Criteria:**
- [ ] `executarMarcadoresOnly` gera NF via `gerarNotaFiscalPedido` apos inserir marcadores
- [ ] `nota_fiscal_id` e salvo em `siso_pedidos` antes de ir para `aguardando_compra`
- [ ] Se NF ja existir (idempotencia), nao gera duplicata
- [ ] Pedido continua indo para `aguardando_compra` normalmente apos NF
- [ ] Log registra geracao de NF para pedidos OC

### US-002: Criacao de agrupamento + expedicao para pedidos OC na aprovacao

**Descricao:** Como operador, quero que pedidos OC ja tenham agrupamento fase 1 criado e concluido na aprovacao, para que na separacao a expedicao ja exista e a fase 2 so precise buscar/cachear a etiqueta.

**Acceptance Criteria:**
- [ ] Apos a NF estar persistida no pedido (`nota_fiscal_id` + `chave_acesso_nf`), o fluxo cria agrupamento via `criarAgrupamento`
- [ ] Agrupamento e concluido via `concluirAgrupamento`
- [ ] Detalhes do agrupamento sao obtidos via `obterAgrupamento` para extrair `expedicao_id`
- [ ] `agrupamento_expedicao_id` e `expedicao_id` sao salvos em `siso_pedidos`
- [ ] ZPL/etiqueta NAO e buscada neste momento
- [ ] Se a NF ainda nao estiver persistida, o agrupamento NAO roda e NAO deve deixar o pedido preso em estado `pending`
- [ ] Se agrupamento falhar, pedido segue sem ele (nao bloqueia) — icone mostra etapa pendente
- [ ] Fire-and-forget: falha no agrupamento nao impede o fluxo de compras

### US-002B: Fase 2 da etiqueta/ZPL somente depois

**Descricao:** Como sistema, quero que a etiqueta/ZPL seja buscada apenas quando fizer sentido operacional, reutilizando agrupamento/expedicao ja criados antes.

**Acceptance Criteria:**
- [ ] A fase 2 da etiqueta so roda em `separado`, embalagem, retry manual ou fluxo equivalente
- [ ] Se `agrupamento_expedicao_id` e `expedicao_id` ja existirem, a fase 2 reaproveita esses dados
- [ ] Se a etiqueta/ZPL nao estiver pronta, o sistema mantem o pedido sem ZPL cacheado e permite retry posterior
- [ ] A fase 2 NAO recria agrupamento quando ele ja existe e esta valido

### US-003: Postergar lancamento de estoque para status "separado"

**Descricao:** Como sistema, quero que o lancamento de estoque (`lancarEstoqueNota`) aconteca somente quando o pedido atinge "separado", para todas as decisoes (propria, transferencia, OC).

**Acceptance Criteria:**
- [ ] `executarSaidaPropria` NAO chama `lancarEstoqueNota` na aprovacao
- [ ] `executarSaidaTransferencia` NAO chama `lancarEstoqueNota` nem faz movimentos fisicos de estoque na aprovacao
- [ ] Ambos geram NF e salvam `nota_fiscal_id` como hoje
- [ ] Novo trigger/hook no endpoint de `concluir` separacao (quando pedido vira "separado") chama `lancarEstoqueNota`
- [ ] Para `propria`, o hook em `separado` lanca o estoque usando a NF ja existente (`nota_fiscal_id` do pedido)
- [ ] Para `transferencia`, o hook em `separado` executa a sequencia correta: `lancarEstoqueNota` na origem para limpar a reserva da NF, `movimentarEstoque(E)` na origem para compensar a baixa contabil, e `movimentarEstoque(S)` na empresa que enviou fisicamente
- [ ] Campo `estoque_lancado` continua sendo atualizado para idempotencia
- [ ] Se lancamento falhar em "separado", pedido e marcado com erro e pode ser retentado
- [ ] Para transferencia, o lancamento de estoque segue a logica de empresa correta (origem vs destino)

### US-004: Manter agrupamento na separacao para propria/transferencia

**Descricao:** Como sistema, o fluxo de agrupamento para pedidos propria e transferencia continua sendo criado quando o pedido atinge "separado" (comportamento atual).

**Acceptance Criteria:**
- [ ] `preCriarAgrupamentosEmLote` continua sendo chamado no endpoint `concluir` para propria/transferencia
- [ ] `preCriarAgrupamentosEmLote` so roda quando a NF estiver persistida no pedido (`nota_fiscal_id` + `chave_acesso_nf`)
- [ ] Nenhuma mudanca no `agrupamento-service.ts` para esses fluxos
- [ ] Para OC, o agrupamento ja existe — `preCriarAgrupamentosEmLote` deve ser idempotente (skip se `agrupamento_expedicao_id` ja preenchido)

### US-005: Backfill de pedidos OC existentes sem NF

**Descricao:** Como admin, quero que pedidos ja em `aguardando_compra` sem NF recebam NF + agrupamento retroativamente.

**Acceptance Criteria:**
- [ ] Script/endpoint de backfill identifica pedidos com `status_separacao = 'aguardando_compra'` e `nota_fiscal_id IS NULL`
- [ ] Para cada pedido, gera NF via Tiny API
- [ ] O backfill espera a NF ficar persistida no pedido (`nota_fiscal_id` + `chave_acesso_nf`) antes de rodar agrupamento fase 1
- [ ] Apos NF persistida, cria agrupamento + conclui + salva `expedicao_id`
- [ ] O backfill NAO busca ZPL/etiqueta; isso continua sendo fase 2
- [ ] Respeita rate limiting por empresa
- [ ] Log de cada pedido processado com sucesso/falha
- [ ] Pode ser executado multiplas vezes (idempotente)

### US-006: Icones de progresso do pipeline nos cards de pedido

**Descricao:** Como operador, quero ver icones coloridos no card de cada pedido mostrando quais etapas do pipeline ja foram concluidas, similar ao sistema de "Integracoes" do Tiny ERP.

**Acceptance Criteria:**
- [ ] 4 icones exibidos em sequencia no card do pedido: **N** (NF), **A** (Agrupamento), **E** (Estoque), **Z** (Etiqueta/ZPL)
- [ ] Cada icone tem 3 estados visuais:
  - Cinza/apagado: etapa pendente (nao iniciada)
  - Colorido/ativo: etapa concluida com sucesso
  - Vermelho/erro: etapa falhou quando houver sinal explicito de erro
- [ ] **N** (NF): ativo quando `nota_fiscal_id IS NOT NULL` e `chave_acesso_nf IS NOT NULL`
- [ ] **A** (Agrupamento): ativo quando `agrupamento_expedicao_id IS NOT NULL` e diferente de `'pending'`
- [ ] **E** (Estoque): ativo quando `estoque_lancado = true`
- [ ] **Z** (Etiqueta): ativo quando `etiqueta_zpl IS NOT NULL`
- [ ] `GET /api/separacao` passa a retornar `status`, `nota_fiscal_id`, `chave_acesso_nf`, `agrupamento_expedicao_id`, `expedicao_id`, `estoque_lancado`, `etiqueta_zpl` e `etiqueta_status`
- [ ] Estado vermelho so e usado quando houver regra objetiva:
  - `N`: `status = 'erro'` e NF ainda nao persistida
  - `A`: `status = 'erro'`, NF persistida e agrupamento ainda ausente
  - `E`: `status = 'erro'` e `estoque_lancado = false` apos tentativa
  - `Z`: `etiqueta_status = 'falhou'`
- [ ] Icones aparecem nos cards de todas as abas de separacao (pendentes, aguardando NF, aguardando OC, em separacao, separados, embalados)
- [ ] Icones sao compactos e nao ocupam espaco excessivo no card
- [ ] Tooltip em cada icone explica a etapa (ex: "Nota Fiscal gerada", "Agrupamento pendente")

### US-007: Ajuste do compras-release para novo fluxo

**Descricao:** Como sistema, o `compras-release` deve ser ajustado para o novo fluxo onde NF e agrupamento ja existem.

**Acceptance Criteria:**
- [ ] `compras-release` continua resolvendo `decisao_final`, `separacao_galpao_id` e o roteamento de execucao futura
- [ ] `compras-release` reconhece que NF persistida significa `nota_fiscal_id IS NOT NULL` e `chave_acesso_nf IS NOT NULL`
- [ ] Pedido vai para `aguardando_separacao` quando a NF ja estiver persistida; se nao estiver, fica em `aguardando_nf` como fallback seguro
- [ ] Job de `lancar_estoque` NAO e criado no release (estoque so e lancado em "separado")
- [ ] Pedido liberado mantem `agrupamento_expedicao_id` e `expedicao_id` intactos
- [ ] Log registra que pedido foi liberado com NF pre-existente

---

## 4. Functional Requirements

**Geracao de NF (OC):**
- FR-1: `executarMarcadoresOnly` deve chamar `gerarNotaFiscalPedido` apos marcadores, antes de enviar para compras
- FR-2: A geracao de NF e idempotente — se `nota_fiscal_id` ja existe, retorna o existente
- FR-3: Assumimos que o Tiny aceita gerar NF independente de estoque disponivel

**Agrupamento (OC):**
- FR-4: A fase 1 do agrupamento so pode rodar quando a NF estiver persistida no pedido (`nota_fiscal_id` + `chave_acesso_nf`)
- FR-5: Apos NF persistida, o fluxo cria agrupamento, conclui, e obtem `expedicao_id`
- FR-6: `agrupamento_expedicao_id` e `expedicao_id` sao salvos no pedido
- FR-7: A fase 1 do agrupamento NAO baixa/cacha ZPL
- FR-8: A fase 2 (etiqueta/ZPL) roda depois, reaproveitando `agrupamento_expedicao_id` + `expedicao_id` quando disponiveis
- FR-9: Falha no agrupamento nao bloqueia o fluxo — pedido segue para compras sem agrupamento
- FR-10: Nenhum entrypoint de agrupamento deve marcar `pending` antes da NF atender a condicao de persistencia
- FR-11: `preCriarAgrupamentosEmLote` deve ser idempotente: skip se agrupamento ja existe

**Lancamento de Estoque:**
- FR-12: `executarSaidaPropria` NAO lanca estoque na aprovacao — so gera NF + marcadores
- FR-13: `executarSaidaTransferencia` NAO lanca estoque nem faz movimentos fisicos na aprovacao — so gera NF + marcadores
- FR-14: Novo hook no endpoint `concluir` (ou `concluir-oc`) chama a rotina correta de estoque quando pedido vira "separado"
- FR-15: Para `propria`, o hook chama `lancarEstoqueNota` usando a NF ja existente
- FR-16: Para `transferencia`, o hook executa `lancarEstoqueNota` na origem, depois `movimentarEstoque(E)` na origem, depois `movimentarEstoque(S)` na empresa que envia fisicamente
- FR-17: `estoque_lancado` e atualizado apos a sequencia completa em "separado"
- FR-18: Se lancamento falhar, pedido fica com `estoque_lancado = false` e icone mostra erro

**Compras-Release:**
- FR-19: `checkAndReleasePedidos` continua resolvendo decisao e galpao de separacao
- FR-20: `checkAndReleasePedidos` nao cria job `lancar_estoque`
- FR-21: Pedido vai para `aguardando_separacao` quando a NF estiver persistida; caso contrario, fica em `aguardando_nf`
- FR-22: Campos de agrupamento/expedicao sao preservados no release

**Backfill:**
- FR-23: Script processa pedidos em `aguardando_compra` com `nota_fiscal_id IS NULL`
- FR-24: O backfill espera a persistencia local da NF antes de rodar agrupamento fase 1
- FR-25: Respeita rate limiting por empresa (`runWithEmpresa`)
- FR-26: Idempotente — pode rodar multiplas vezes sem duplicar NFs ou agrupamentos

**Icones de Progresso:**
- FR-27: Componente `PipelineIcons` renderiza 4 icones (N, A, E, Z) com estados cinza/ativo/erro
- FR-28: `GET /api/separacao` expoe os campos necessarios para o pipeline visual
- FR-29: Integrado nos cards de separacao (`separacao-card.tsx`, `pedido-separacao-card.tsx`)

---

## 5. Non-Goals (Out of Scope)

- Mudar a logica de decisao (propria/transferencia/oc) — so muda o que acontece DEPOIS da decisao
- Mudar o fluxo de agrupamento para propria/transferencia (continua em "separado")
- Cachear ZPL/etiqueta antecipadamente — continua so em "separado"
- Mudar a interface do SISO dashboard (painel de aprovacao) — icones sao so na separacao
- Criar novo endpoint de API para etiquetas — usa o existente
- Mudar o webhook de nota fiscal (`nf-webhook-handler.ts`) — NF e gerada ativamente, nao via webhook

---

## 6. Technical Considerations

### Arquivos impactados

| Arquivo | Mudanca |
|---|---|
| `src/lib/execution-worker.ts` | `executarMarcadoresOnly`: + NF + trigger da fase 1 do agrupamento apos NF persistida. `executarSaidaPropria`/`executarSaidaTransferencia`: remover lancamento de estoque da aprovacao |
| `src/lib/compras-release.ts` | Manter resolucao de decisao/galpao. Remover criacao de job `lancar_estoque` |
| `src/lib/agrupamento-service.ts` | Separar fase 1 (agrupamento/expedicao) da fase 2 (etiqueta/ZPL). Bloquear execucao ate NF persistida |
| `src/lib/pedido-routing.ts` | Novo helper compartilhado para resolver decisao/empresa de execucao/galpao entre `compras-release` e hook de `separado` |
| `src/app/api/separacao/concluir/route.ts` | Adicionar `lancarEstoqueNota` quando pedido vira "separado" |
| `src/app/api/separacao/concluir-oc/route.ts` | Adicionar `lancarEstoqueNota` quando pedido OC vira "separado" |
| `src/app/api/separacao/route.ts` | Expor campos do pipeline visual (`nota_fiscal_id`, `chave_acesso_nf`, `agrupamento_expedicao_id`, `expedicao_id`, `estoque_lancado`, `etiqueta_zpl`, `etiqueta_status`) |
| `src/app/api/separacao/encaminhar/route.ts` | Preservar NF antecipada e limpar agrupamento/expedicao/etiqueta quando o roteamento mudar |
| `src/components/separacao/*.tsx` | Integrar componente `PipelineIcons` |
| Novo: `src/components/separacao/pipeline-icons.tsx` | Componente de icones de progresso |
| Novo: script backfill | Script para processar pedidos OC existentes |

### Dependencias

- Tiny API v3: `gerarNotaFiscal`, `criarAgrupamento`, `concluirAgrupamento`, `obterAgrupamento`, `lancarEstoqueNota`, `movimentarEstoque`
- Rate limiter por empresa (ja existente)
- Campos existentes em `siso_pedidos`: `nota_fiscal_id`, `chave_acesso_nf`, `agrupamento_expedicao_id`, `expedicao_id`, `estoque_lancado`, `etiqueta_zpl`, `etiqueta_status`

### Riscos

- **Tiny recusar NF para OC sem estoque**: Assumimos que aceita (resposta 1C). Se nao aceitar, NF fica pendente e icone mostra cinza.
- **Race condition entre NF e agrupamento**: toda chamada de agrupamento deve ser bloqueada ate `nota_fiscal_id` + `chave_acesso_nf` estarem persistidos no pedido.
- **Race condition no lancamento de estoque em "separado"**: Usar `estoque_lancado` como guard (idempotencia existente).
- **Transferencia com NF antecipada**: a sequencia de estoque no `separado` precisa manter a compensacao na origem e a baixa fisica na empresa que enviou, sem simplificar para um unico `lancarEstoqueNota`.
- **Mudanca de galpao apos NF antecipada**: agrupamento/expedicao/etiqueta podem ficar invalidos e devem ser limpos/recriados quando o roteamento mudar.
- **Backfill com muitos pedidos**: Processar em batches com rate limiting.

---

## 7. Success Metrics

- 100% dos pedidos OC novos chegam em "separado" com NF + agrupamento + expedicao_id ja preenchidos
- Tempo de obtencao de etiqueta em "separado" para OC reduzido (so 1 chamada de API vs 4+)
- Zero regressoes nos fluxos de propria/transferencia
- Operadores conseguem ver o progresso visual de cada pedido pelos icones
- Backfill processa todos os pedidos OC existentes sem NF

---

## 8. Open Questions

- **OQ-1**: Se o Tiny recusar gerar NF para pedido OC sem estoque, qual o fallback exato? (Assumimos que aceita, mas precisa testar)
- **OQ-2**: O lancamento de estoque em "separado" deve ser sincrono (bloqueia o operador) ou fire-and-forget?
- **OQ-3**: Os icones de progresso devem aparecer tambem nos cards do SISO dashboard (aba pendentes/concluidos) ou so na separacao?
- **OQ-4**: Para o backfill, rodar como script CLI, como endpoint de API, ou como cron?
