# Architecture and Flows

> System architecture and business flow documentation for SISO / WMS.
> For detailed visual diagrams per module, see `docs/fluxos/`.
> For API contracts, see `docs/api-reference-complete.md`.
> For database schema, see `docs/database-schema.md`.

---

## Ledger Simplificado 3D (2026-05-20)

Estoque deixou de ser 4D (produto × dona × galpão × loc) e virou **3D** (produto × galpão × loc). Empresa não é mais coordenada física — viaja como TAG na movimentação quando há NF (compradora/vendedora/referência), permitindo apuração contábil por empresa via report sem fragmentar o estoque físico.

### Propriedades

- **`siso_estoque.UNIQUE (produto_id, galpao_id, localizacao_id)`** — peças idênticas no mesmo endereço são fungíveis. Não há mais "estoque da NetAir" vs "estoque da NetParts" na mesma loc.
- **`siso_movimentacoes`** carrega 9 colunas de metadata (todas nullable): `empresa_compradora_id`, `empresa_vendedora_id`, `empresa_referencia_id`, `fornecedor_id`, `motivo`, `cliente_nome`, `custo_unitario`, `custo_medio_anterior`, `custo_medio_posterior`.
- **`siso_custo_medio`** — cache global por produto (PK `produto_id`). Atualizado pelo RPC `wms_inserir_movimentacao` em toda entrada com `custo_unitario` via média ponderada.
- **Empréstimo entre empresas, swap N×N e mini-swap intra-galpão foram arquivados.** Código preservado em `src/lib/wms/_archive/`. Algoritmos não fazem sentido sem dona física.
- **Apuração por empresa = report** em `/api/wms/relatorios/*` (3 endpoints: movs-por-empresa, historico-custo, saldos-por-empresa).

### Stock check no pedido (cross-empresa do mesmo grupo)

Quando o webhook chega:

1. Identifica empresa pelo CNPJ → resolve grupo (via `siso_grupo_empresas`).
2. **NÃO** itera por empresa — pool físico é fungível por galpão. Consulta `siso_estoque` agregado por (produto, galpão).
3. Decide entre `propria` (mesmo galpão da origem) / `transferencia` (galpão diferente, todos os itens cobertos) / `oc` (sem cobertura).
4. Auto-aprova apenas `propria`; demais vão pro operador.
5. Na dedução pós-aprovação, a mov S vai com `empresa_vendedora_id` = empresa origem do pedido (a empresa que emite a NF).

---

## Recebimento (entrada com NF + metadata 3D)

```mermaid
sequenceDiagram
  participant Op as Operador
  participant API as POST /api/wms/receber
  participant RPC as wms_inserir_movimentacao
  participant Cache as siso_custo_medio
  participant Pend as siso_wms_pendencias_guarda

  Op->>API: { galpao_id, empresa_compradora_id, fornecedor_id, itens: [{ produto, qty, custo_unitario }] }
  loop por item
    API->>RPC: mov E (loc=RECEBIMENTO no modo padrão, ou loc=destino no modo entrada_direta)
    RPC->>RPC: lock pessimista (produto, galpão, loc)
    alt custo_unitario > 0
      RPC->>Cache: lê custo médio atual
      RPC->>RPC: média ponderada (saldo_atual * custo_atual + qty * custo_novo) / (saldo + qty)
      RPC->>Cache: UPSERT custo_medio + ultima_movimentacao_id
      RPC->>RPC: grava custo_medio_anterior/posterior na mov
    end
    RPC->>RPC: insere mov com empresa_compradora_id + fornecedor_id (tags)
    RPC->>RPC: atualiza siso_estoque cache
    RPC-->>API: mov_id
    opt modo padrão (entrada_direta=false)
      API->>Pend: cria pendencia (qty_inicial, mov_entrada_id, status=pendente)
    end
  end
  API-->>Op: { mov_ids, pendencia_ids? }
```

### Side effects do RPC

- Lock pessimista por (produto, galpão, loc) — bloqueia até resolver.
- Atualiza saldo no `siso_estoque` (UNIQUE 3D).
- Em E com `custo_unitario`: recalcula `siso_custo_medio` globalmente e populates `custo_medio_anterior/posterior` na mov pra rastreio histórico.
- Tags `empresa_compradora_id` + `fornecedor_id` ficam na mov pra apuração via `/api/wms/relatorios/movs-por-empresa`.

---

## Devolução de Cliente (classificação A/B/C/D, 3D)

```mermaid
flowchart TD
  NFe[NF de devolução chega via webhook] --> Pend[siso_devolucoes_pendentes status=aguardando_classificacao]
  Pend --> UI[Operador abre /wms/devolucoes/[id]]
  UI -->|Body: { classificacao, produto_id, qty, galpao_id, localizacao_id, empresa_referencia_id?, fornecedor_id? }| API[POST /api/wms/devolucoes/[id]/classificar]
  API --> Branch{classificacao}

  Branch -->|A — íntegro| A[mov E origem=devolucao_cliente_integra<br/>+ empresa_referencia_id<br/>+ RPC recalcula siso_custo_medio]
  Branch -->|B — avariado| B[mov E origem=devolucao_cliente_avariada<br/>+ par S+E transferindo pra QUARENTENA<br/>custo médio NÃO recalcula]
  Branch -->|C — garantia/RMA| C[mov E origem=devolucao_cliente_integra<br/>+ mov S origem=devolucao_fornecedor_enviada<br/>+ fornecedor_id em ambas]
  Branch -->|D — troca SKU| D[mov E origem=devolucao_cliente_integra<br/>+ troca real fica no SISO por enquanto]

  A --> Fim[siso_devolucoes_pendentes.status=classificada]
  B --> Fim
  C --> Fim
  D --> Fim
```

### Notas

- `empresa_referencia_id` (tag) substitui o antigo `empresa_dona_destino_id` — não muda coordenada física, só registra qual empresa "originou" a devolução pra apuração.
- `fornecedor_id` é obrigatório em classificação `C` (garantia → RMA) pra emissão da NF de saída pro fornecedor.
- Custo médio só recalcula em entrada com peça íntegra (A, C-entry). Avaria não entra na média.

---

## Reconciliação temporal (estoque online, 3D)

Inventário roda em paralelo com operação (picking, recebimento, ajustes). Não há freeze. Cada contagem grava `criado_em` em `siso_inventario_contagens`. No fechamento da sessão, `computarDivergencias` faz:

1. Snapshot `cutoff_em = now()` (imutável durante a execução).
2. Para cada **tripla** `(loc, produto, galpão)` contada (3D — não há mais `dona` no DISTINCT), calcula `T_ref = max(contado_em)`.
3. Busca em `siso_movimentacoes` a primeira mov "efetiva" na tripla com `criado_em > T_ref AND criado_em <= cutoff_em`. "Efetiva" = não estornada (nem é estorno) e não é da própria sessão.
4. `saldo_esperado` = `saldo_anterior` dessa mov, ou `saldo_atual` se não houver.
5. `delta = qty_contada - saldo_esperado`.

Locs visitadas com saldo > 0 mas sem contagens geram divergência `qty=0` apenas se o saldo já existia antes de `contagem_finalizada_em`. Entrada após a visita não conta.

Movs criadas após `cutoff_em` ficam para a próxima sessão (princípio: aprovação congela o universo).

Implementação:
- Função pura: `src/lib/wms/inventario-reconciliacao.ts` (testada em `inventario-reconciliacao.test.ts`)
- Wrapper com I/O: `src/lib/wms/inventario.ts::computarDivergencias`

---

*Last updated: 2026-05-20 — Ledger Simplificado 3D rollout (drop dona física, empresa como tag em movs).*

---

## Roles & Permissões

Controle de acesso é via RBAC dinâmico desde 2026-05-21.

### Fluxo de check

1. **Registry (`src/lib/permissions.ts`):** lista canônica de 31 permissões em 8 módulos. Permissões são contratos com o código — cada `userCan(session, "X")` precisa ter X no registry.
2. **Roles (`siso_roles`):** agrupamentos editáveis pelo admin. 6 roles sistema (`admin`, `operador`, `operador_cwb`, `operador_sp`, `comprador`, `vendedor`) não-deletáveis; outras criadas dinamicamente.
3. **Atribuição (`siso_usuario_roles`):** usuário tem 1..N roles. Permissões efetivas = união dos `siso_role_permissoes` das roles ativas.
4. **Sessão:** `getSessionUser()` carrega `permissoes: Set<string>` em cada request (1 query JOIN, ~ms). Fallback: se usuário não tem `siso_usuario_roles`, busca por `cargos[]`.
5. **Check:** `userCan(session, "compras.executar")` em backend; `usePermissoes().can(...)` em client.

### Defesa em camadas
- **UI esconde** items da sidebar e botões via `requires` / `can()`.
- **API valida** a maioria dos endpoints sensíveis com `userCan`; defesa em profundidade vai sendo aplicada conforme cleanup. Helpers compartilhados (`requireAdmin`, `requireWarehouseAccess`) também checam permissões.
- **DB protege** anti-lockout via RPC `wms_role_delete` + validação no endpoint `/usuarios/[id]/roles`.

### Compat legado
`siso_usuarios.cargo` e `.cargos[]` continuam existindo (nullable, espelhados por trigger `trg_sync_cargos_after_roles`). Código novo nunca lê esses campos — só permissoes. Remoção definitiva planejada para ~1 mês após Fase 3 estabilizar.

---

## Quadro de Tarefas Pendentes — home /wms (P5, 2026-05-26)

A home `/wms` é PageHeader + `<QuadroTarefas>`. O quadro divide o que o operador precisa enxergar em 3 zonas:

### 1. Pipeline do pedido (3 cards horizontais no topo)

| Card | Contador | Split |
|---|---|---|
| Aprovação | `aprovacao.count` | `marketplace` vs `manual` (P5) |
| Separação | `separacao.count` | avatares ao vivo via presença WMS |
| Embalagem | `embalagem.count` | avatares ao vivo |

### 2. Kanban operacional (3 colunas)

- **Guarda** — `siso_wms_pendencias_guarda` em `pendente`/`em_guarda`. Cards individuais com SKU + qty + idade + avatar.
- **Inventário** — sessões `em_andamento` com progresso `locs_contadas / locs_total` e party ativa.
- **Compras** — agrupado por fornecedor: `a_comprar` (itens) + `a_receber` (ordens).

### 3. Seção Exceções (P5)

Abaixo do kanban, a seção `<SecaoExcecoes>` agrupa 6 categorias de pendência que quebram o fluxo normal e exigem ação operacional. Default expandido se qualquer contador > 0; colapsável manualmente (estado perde no F5 intencionalmente — primeira impressão importa).

| # | Card | Trigger |
|---|---|---|
| 1 | **Devoluções pendentes** | `siso_devolucoes_pendentes.status='aguardando_classificacao'` |
| 2 | **Transferências em trânsito** | `siso_transferencias_galpao.status='em_transito'`. Idade visível (>48h fica vermelho). |
| 3 | **Inventário em revisão** | `siso_inventario_sessoes.status='revisao'` + divergências pendentes contadas |
| 4 | **Reservas órfãs** | Mov R com `origem_tipo='reserva_pedido'`, pedido cancelado, sem estorno. Alerta vermelho >5. |
| 5 | **Retroativos pendentes** | Movs `origem_tipo='lancamento_retroativo'` não-estornadas |
| 6 | **Saldo órfão em RECEBIMENTO** | `siso_estoque` em loc tipo='recebimento' com saldo > 0 sem pendência viva |

### Realtime

Hook `useDashboardTarefasRealtime(galpaoId)` subscribe a 8 tabelas via Supabase Realtime. Invalidates são **debounced em 250ms** pra coalesce eventos rapid-fire. Fallback: `staleTime=0 + refetchInterval=30_000` no useQuery.

Tabelas assinadas (devem estar na publication `supabase_realtime` — verificada em P1):

1. `siso_pedidos`
2. `siso_wms_pendencias_guarda`
3. `siso_inventario_sessoes`
4. `siso_inventario_operadores`
5. `siso_pedido_itens`
6. `siso_devolucoes_pendentes` (P5)
7. `siso_transferencias_galpao` (P5)
8. `siso_movimentacoes` filtrado `tipo=eq.R` (P5)

### Fix de galpão filter (P5)

Bug 0.5/5.8: filtro `galpao_id` aplicava `eq('separacao_galpao_id', galpao_id)` em pedidos pendentes, mas pedidos pendentes **ainda não aprovados** têm `separacao_galpao_id IS NULL` — escondia ~69% dos pendentes em prod. Fix: para `status='pendente'`, usar `OR(separacao_galpao_id.eq.X, separacao_galpao_id.is.null)`. Para fluxos pós-aprovação (separacao/embalagem) a invariante `separacao_galpao_id IS NOT NULL` é mantida pelo `pedidos/aprovar`.

---

## Reverse paritária (P3 — 2026-05-27)

Princípio: **toda ação que insere movs no ledger deve ter uma contraparte de reversão**.
Antes do P3, várias operações WMS eram "one-way": confirmavam saldo no ledger mas não tinham
botão pra desfazer (operador precisava abrir ticket pra admin executar SQL manual). P3 fecha
essa lacuna com 7 endpoints reverse e ajustes pra preservar invariantes do ledger.

| Ação forward | Endpoint reverso (P3) | Estorna que? |
|---|---|---|
| `POST /api/wms/inventario/[id]/aplicar` (gera movs `inventario_perda/ganho` por divergência) | `POST /api/wms/inventario/[id]/estornar` **(admin)** | Para cada divergência `aplicada`, estorna a mov gerada e volta divergência pra `pendente`. Sessão volta pra `revisao`. |
| `POST /api/wms/guarda/[id]/confirmar` (par S+E RECEBIMENTO→loc destino) | `POST /api/wms/guarda/[id]/desfazer` | Estorna a última confirmação (S+E), decrementa `qty_guardada`, restaura status da pendência. |
| `POST /api/wms/devolucoes/[id]/classificar` (E + transferência opcional pra QUARENTENA + RMA) | `POST /api/wms/devolucoes/[id]/desclassificar` | Match por janela temporal ±60s da `classificada_em` + origem_tipo + (NF/produto quando disponíveis). Estorna todas as movs e volta pra `aguardando_classificacao`. |
| `POST /api/wms/replenishment` (S+E intra-galpão) | `POST /api/wms/replenishment/[origem_id]/reverter` | Estorna ambas as legs (idempotente — chamadas repetidas pulam movs já estornadas). |
| `POST /api/wms/ajuste` (mov manual S ou E) | `POST /api/wms/ajuste/[mov_id]/estornar` | Estorna a mov; valida `origem_tipo='ajuste_manual'` antes (recusa estornar movs de outras origens por esse endpoint). |
| `POST /api/wms/vendas/criar` (baixa_direta gera S por item; modo separação gera R) | `POST /api/wms/vendas/[id]/cancelar` | Estorna movs S (idempotente) ou libera R conforme o status atual. Rejeita 400 se status_separacao ∈ {em_separacao,separado,embalado} — operador deve `voltar-etapa` primeiro. |
| `POST /api/wms/transferencias/[id]/receber` (E destino) | `POST /api/wms/transferencias/[id]/desfazer-recebimento` | Estorna **só a leg E** + reset itens + header volta pra `em_transito`. A leg S continua (estoque continua em trânsito). Permite re-receber. |

### Atomicidade reforçada (RPCs)

Migrations P3 movem 2 fluxos multi-step do TS pra RPC SQL atômica:
- `wms_replenishment_intra_galpao` — S+E numa transação única. Antes, crash entre S e E
  deixava saldo evaporando. Endpoint `/api/wms/replenishment` consome via `replenishmentIntraGalpao()`.
- `wms_confirmar_guarda_atomico` — S+E + UPDATE de `siso_wms_pendencias_guarda` (`qty_guardada`,
  `status`) numa transação única. Antes, crash entre mov e UPDATE deixava saldo movido mas
  pendência não atualizada (estado fantasma). Endpoint `/api/wms/guarda/[id]/confirmar` consome.

### Idempotência (UNIQUE constraint)

`aplicar` em duas requisições paralelas competia pra inserir 2 movs com o mesmo `origem_id`
(divergencia_id). UNIQUE partial index `uniq_movs_inventario_divergencia` (`origem_id`,
`origem_tipo`) WHERE `origem_tipo IN ('inventario_perda','inventario_ganho')` em
`siso_movimentacoes` garante que o 2º recebe **SQLSTATE 23505** (traduzido como
ConflictError `{ code: 'DIVERGENCIA_JA_APLICADA' }`) e o caller pula a div, continua com as demais.

### Anti-race em fluxos críticos

- **`iniciarGuarda`** (#5.2): UPDATE condicional `WHERE status='pendente'`; 2º operador recebe **409 PENDENCIA_OUTRA_GUARDA**.
- **`registrarContagem`** (#4.3): exige `siso_inventario_localizacoes.bloqueada_por = caller`; sem lock retorna **409 LOC_NAO_BLOQUEADA**.
- **`receberTransferencia`** (#8.10): claim lock via `siso_transferencias_galpao.recebimento_em_andamento_por`; 2º operador recebe **409 TRANSFERENCIA_OUTRO_RECEBIMENTO**.
- **`computarDivergencias` / `aprovarSessao`** (#4.5/#4.6): retorna **409 OPERADORES_ATIVOS** se há ops bipando; supervisor pode bypassar via `force: true`.
- **`marcar-item` desmarcar** (#2.7): estorna leg S **antes** da leg L, preservando invariante I2 (saldo_anterior + delta = saldo_posterior) durante o estorno em par.

### Estado fantasma fix (#2.10)

`reiniciar` com `etapa='embalagem'` agora invoca `reverterCutoverDoPedido` em
`src/lib/wms/cutover.ts` — estorna as movs `'L'` (liberação reserva) e `'S'` (saída) emitidas
no cutover anterior + recria as reservas R com saldo. Antes, voltar etapa de embalagem
deixava saldo permanentemente saído sem caminho de volta (estado fantasma).

### `lancamento-retroativo/[id]/reconciliar` (#8.6)

Endpoint agora valida UUID format de `[id]` e `compra_mov_id` (regex) **antes** de chamar a
RPC, e SELECT verifica existência das duas movs. Antes, caller podia passar string vazia/uuid
inexistente e receber 23502/23503 cripticamente.
