# Quadro de Tarefas Pendentes na home `/wms` — Design

**Status:** Approved — pending implementation plan
**Data:** 2026-05-21
**Autor:** brainstorm Eryk + Claude

## Contexto

Hoje a home `/wms` (`src/app/wms/page.tsx`) é um **hub de navegação** — grupos `Visibilidade / Operações / Inventário / Relatórios / Cadastros` com cards que linkam pras subtelas. É útil pra quem sabe onde quer ir, mas não responde à pergunta que mais aparece no chão de operação:

> "Estou ocioso. O que tem pra fazer agora?"

Hoje, pra responder isso, o operador precisa abrir `/wms/separacao`, `/wms/guarda`, `/wms/inventario`, `/wms/compras` um por um e checar se cada fila tem trabalho. O `/wms/dashboard` atual existe mas é uma visão de **saúde do sistema** (cobertura crítica, divergências de inventário, locks órfãos, reservas expirando) — não é fila de trabalho.

## Objetivo

Adicionar um **Quadro de Tarefas Pendentes** no topo da home `/wms` que mostra, em uma única vista ao vivo, todas as filas operacionais com volume + quem está executando, pra que em qualquer tempo ocioso o operador bata o olho e escolha onde ajudar.

## Decisões fundamentais (firmadas no brainstorm)

- **Vira a home.** Não é rota dedicada; é um bloco no topo de `/wms`. Hub de navegação atual fica intacto embaixo.
- **6 filas** em duas linhas semânticas: pipeline do pedido (3) + tarefas adjacentes (3).
- **Card = contador + avatares** dos executores ativos. Card inteiro é `<Link>` (sem CTA separado).
- **Respeita o galpão** selecionado no `sidebar-galpao-switcher` — mesmo padrão das outras páginas WMS.
- **Todos os cargos** que chegam à home veem todos os cards (vendedor já é redirecionado pra `/wms/vendas` pelo guard de layout — não cai aqui).
- **Realtime** via Supabase Realtime (não polling). Avatares e contadores movem em segundos.
- **Cards vazios** ficam esmaecidos mas visíveis — operador vê o que está limpo vs lotado.
- **YAGNI:** sem idade da fila, sem badges de urgência, sem expedição/devoluções/retroativos. Endpoint é extensível pra acrescentar depois.

## 1. Estrutura da home `/wms`

`src/app/wms/page.tsx` ganha o bloco novo no topo. Mantém `PageHeader`, ações "Ajustar" e "Receber mercadoria", e todos os `GROUPS` de navegação embaixo. Subtítulo do `PageHeader` muda pra refletir o galpão ativo.

```
PageHeader
─────────────────────────
QuadroTarefas (novo)
─────────────────────────
GROUPS de navegação (intactos)
```

## 2. Layout do quadro

```
┌──────────────────────────────────────────────────────────────────┐
│  Tarefas pendentes                  galpão: CWB     ● ao vivo    │
│                                                                  │
│  Pipeline do pedido                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │ Aprovação    │  │ Separação    │  │ Embalagem    │            │
│  │      3       │  │     12       │  │      5       │            │
│  │ aguardando   │  │ ●●● +2       │  │ ●●           │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
│                                                                  │
│  Tarefas adjacentes                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│  │ Guarda       │  │ Compras      │  │ Inventário   │            │
│  │      8       │  │   4 / 2      │  │      2       │            │
│  │ ●            │  │ comprar/rec  │  │ ●●           │            │
│  └──────────────┘  └──────────────┘  └──────────────┘            │
└──────────────────────────────────────────────────────────────────┘
```

- Grid `3 colunas × 2 linhas` no desktop; `1 coluna` no mobile (todos os 6 cards empilhados).
- Cada linha tem um **subtítulo** ("Pipeline do pedido" / "Tarefas adjacentes") em texto pequeno.
- Card inteiro é `<Link>` clicável.
- Card com contador zero: `opacity 0.5`, fundo neutro, texto "Tudo em dia". Continua visível.
- Card com contador > 0: borda mais forte, contador grande tabular-nums, avatares no rodapé.

### Avatares

- Componente `<Avatar size="sm">` reusado de `src/components/wms/ui/avatar.tsx`.
- Mostra `foto_url` quando existe; senão, iniciais com fundo hash-color determinístico.
- Máximo **5 avatares visíveis** + chip `+N` pra overflow.
- Tooltip com nome no hover.
- Dedupe por `usuario_id` (mesmo operador executando 2 separações conta uma vez no card).

## 3. Fontes de dados por card

| Card | Contador | Avatares (executores) | Link |
|---|---|---|---|
| **Aprovação** | `siso_pedidos` WHERE `status='pendente'` AND `separacao_galpao_id` = ativo | — sem executor (é fila de decisão) | `/wms/pedidos` |
| **Separação** | `siso_pedidos` WHERE `status_separacao` ∈ (`aguardando_separacao`, `em_separacao`, `pendente_realocacao`, `validacao_oc`) AND `separacao_galpao_id` = ativo | `separacao_operador_id` dos pedidos em `em_separacao` | `/wms/separacao` |
| **Embalagem** | `siso_pedidos` WHERE `status_separacao='separado'` AND `separacao_galpao_id` = ativo | `embalagem_operador_id` quando setado | `/wms/separacao` (a aba de embalagem já existe na página) |
| **Guarda** | `siso_wms_pendencias_guarda` WHERE `status` ∈ (`pendente`,`em_guarda`) AND `galpao_id` = ativo | `iniciada_por` das pendências em `em_guarda` | `/wms/guarda` |
| **Compras** | dois contadores: (a) `siso_pedido_itens` WHERE `compra_status='aguardando_compra'`; (b) ordens de compra abertas pra recebimento | — | `/wms/compras` |
| **Inventário** | `siso_inventario_sessoes` WHERE `status='em_andamento'` AND `galpao_id` = ativo | `siso_inventario_operadores` WHERE `finalizado_em IS NULL` agregado entre todas as sessões ativas | `/wms/inventario` |

**Resolução do galpão por pedido:** todos os pedidos vivem em `siso_pedidos.separacao_galpao_id`, setado pelo webhook no momento da criação (antes da aprovação). O endpoint filtra `WHERE separacao_galpao_id = $galpao_ativo` nos cards Aprovação, Separação e Embalagem.

**Compras:** o card mostra dois números separados pelo `/` ("4 / 2") com legenda "comprar/receber". Não há executor atribuído nessa fila.

**Aprovação:** mesmo sem executor, conta como tarefa pendente — é decisão humana esperando alguém. Card aparece sem avatares.

## 4. Backend

### Endpoint único

`GET /api/wms/dashboard-tarefas?galpao_id={uuid}`

**Auth:** sessão válida (qualquer cargo que tenha acesso a `/wms` — vendedor não chega aqui porque o layout já redireciona pra `/wms/vendas`).

**Query string:** `galpao_id` (opcional — omite filtro quando ausente, equivalente a "Todos os galpões").

**Resposta:**

```ts
type Executor = { id: string; nome: string; foto_url: string | null };

type DashboardTarefasResult = {
  galpao_id: string | null;
  aprovacao:  { count: number };
  separacao:  { count: number; executores: Executor[] };
  embalagem:  { count: number; executores: Executor[] };
  guarda:     { count: number; executores: Executor[] };
  compras:    { aComprar: number; aReceber: number };
  inventario: { sessoesAtivas: number; executores: Executor[] };
};
```

### Camada de serviço

`src/lib/wms/dashboard-tarefas.ts` com função pura:

```ts
export async function montarDashboardTarefas(
  supabase: SupabaseClient,
  galpao_id: string | null,
): Promise<DashboardTarefasResult>
```

**Implementação:** 6 queries em paralelo via `Promise.all`. Cada query retorna `{ count }` + opcionalmente lista de `usuario_id`s. Hidrata avatares numa última query única em `siso_usuarios` (dedupe + select de `id, nome, foto_url`). Total: 7 queries por requisição, todas indexadas em colunas que já existem.

**Filtragem por galpão:**

- **Separação/Embalagem/Aprovação:** filtra por `siso_pedidos.separacao_galpao_id` (setado pelo webhook na criação).
- **Guarda:** filtra por `siso_wms_pendencias_guarda.galpao_id`.
- **Inventário:** filtra por `siso_inventario_sessoes.galpao_id`.
- **Compras:** **não filtra por galpão** — fila de compras é cross-galpão (o item ainda não tem destino físico). O contador é global por agora.

## 5. Realtime

Hook `useDashboardTarefasRealtime(galpao_id)` em `src/hooks/use-dashboard-tarefas-realtime.ts`:

- Subscreve nestes canais Supabase (com filtro server-side por `galpao_id` quando aplicável):
  - `postgres_changes` em `siso_pedidos` (eventos UPDATE em `status`, `status_separacao`, `separacao_operador_id`, `embalagem_operador_id`)
  - `postgres_changes` em `siso_wms_pendencias_guarda` (INSERT/UPDATE)
  - `postgres_changes` em `siso_inventario_sessoes` (UPDATE `status`)
  - `postgres_changes` em `siso_inventario_operadores` (INSERT/UPDATE `finalizado_em`)
  - `postgres_changes` em `siso_pedido_itens` (UPDATE `compra_status`)
- Cada evento dispara `queryClient.invalidateQueries({ queryKey: ['wms-tarefas-pendentes', galpao_id] })`.
- React Query refetch o endpoint único.
- Cleanup dos channels no unmount + ao trocar de `galpao_id`.

**Por que invalidar e re-fetch (não mutar in-place):** mais simples, evita lógica de merge complexa, custo de uma query de 7 statements é negligenciável dado a frequência esperada de eventos (~poucos por minuto em horário de pico).

## 6. Componentes

- `src/app/wms/page.tsx` — modificado: adiciona `<QuadroTarefas />` antes dos `GROUPS`. Lê `galpao_id` ativo do contexto da shell.
- `src/components/wms/home/quadro-tarefas.tsx` — novo. Wrapper com header ("Tarefas pendentes · galpão · ● ao vivo") e os 6 cards organizados em 2 grupos (Pipeline + Adjacentes). Usa `useQuery` + `useDashboardTarefasRealtime`.
- `src/components/wms/home/card-tarefa.tsx` — novo. Card genérico. Props:
  ```ts
  type CardTarefaProps =
    | { variante: "simples"; titulo: string; contador: number; legenda?: string; executores?: Executor[]; href: string }
    | { variante: "dupla"; titulo: string; contadores: [number, number]; legendas: [string, string]; href: string };
  ```
- Reusa `<Avatar size="sm">` de `src/components/wms/ui/avatar.tsx`.
- Estilos seguem padrão existente `wms-home-card` + classes novas `wms-card-tarefa`, `wms-card-tarefa-empty`.

## 7. Como obter o `galpao_id` ativo

O galpão ativo já vive em `useAuth()` no `auth-context.tsx` — exposto como `activeGalpaoId` (e setter `setActiveGalpao`). O `<SidebarGalpaoSwitcher>` lê de lá. Basta usar `const { activeGalpaoId } = useAuth()` no `<QuadroTarefas>`.

**Tratamento de `null`:** `activeGalpaoId === null` significa "Todos os galpões" (admin sem filtro). Quando null, o endpoint omite o filtro `WHERE separacao_galpao_id = …` e agrega de todos os galpões. Mesmo comportamento pra Guarda e Inventário.

## 8. Casos de borda

- **Galpão sem nada pendente:** os 6 cards ficam esmaecidos. Continuam visíveis com "Tudo em dia".
- **Sem galpão selecionado (`activeGalpaoId === null`):** quadro funciona em modo "Todos os galpões" — agrega de todos. Subtítulo do header diz "Todos os galpões".
- **Erro na requisição:** `<ErrorBanner>` com botão refetch (mesmo padrão do dashboard atual).
- **Loading inicial:** placeholder de 6 skeletons (cards cinza com altura fixa). Não mostra `LoadingSpinner` central — evita layout shift dramático.
- **Realtime desconecta:** indicador "● ao vivo" vira "○ reconectando" em cinza; React Query mantém última snapshot até reconectar.

## 9. O que NÃO faz parte (YAGNI)

- Idade da fila / "pedido mais antigo aguardando há X min" — pode entrar depois se houver demanda.
- Badges de urgência (crítico / atenção).
- Cards de Expedição (`status_separacao='embalado'`), Devoluções, Retroativos — endpoint é extensível, adicionar depois se necessário.
- Filtro multi-galpão / opção "todos os galpões" — fora de escopo.
- Visibilidade diferenciada por cargo — todos veem todos os 6 cards.
- Métricas históricas / gráfico de evolução das filas.

## 10. Arquivos afetados

**Criados:**

- `src/lib/wms/dashboard-tarefas.ts` (service)
- `src/lib/wms/dashboard-tarefas.test.ts` (testes da função pura de montagem)
- `src/app/api/wms/dashboard-tarefas/route.ts` (endpoint)
- `src/hooks/use-dashboard-tarefas-realtime.ts` (hook realtime)
- `src/components/wms/home/quadro-tarefas.tsx`
- `src/components/wms/home/card-tarefa.tsx`

**Modificados:**

- `src/app/wms/page.tsx` (adiciona quadro no topo)
- `src/components/wms/wms-shell.tsx` ou contexto (se precisar expor o galpão ativo)
- `src/app/wms/wms.css` ou `globals.css` (classes novas de card)
- `docs/api-reference-complete.md` (documentar nova rota)
- `CLAUDE.md` (acrescentar entrada em "Recently Added")

**Sem migrations.** Todas as colunas necessárias já existem.

## 11. Critérios de sucesso

- Operador abre `/wms` e vê em <1 segundo o estado de 6 filas do galpão ativo.
- Quando alguém começa uma separação/embalagem/guarda/inventário em outra máquina, o avatar aparece no card em menos de 3 segundos sem refresh manual.
- Mudar de galpão na sidebar reflete instantaneamente no quadro (cancela subscriptions antigas, abre novas, refetch).
- Card com zero pendentes está visualmente claro como "limpo" sem desaparecer.
- Hub de navegação existente continua funcional embaixo do quadro.
