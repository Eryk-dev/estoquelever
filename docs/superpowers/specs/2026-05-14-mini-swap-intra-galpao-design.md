# Mini-Swap Intra-Galpão — Design

**Data:** 2026-05-14
**Status:** Spec aprovada, aguardando plano de implementação
**Autor:** brainstorm com Eryk
**Spec relacionada (futuro):** `2026-05-XX-cycle-count-oportunista-design.md` (depende deste)

---

## 1. Resumo executivo

Antes de iniciar uma wave de picking, **rearranjar contábilmente** o estoque das empresas no galpão para que cada SKU fique consolidado em **1 localização canônica de picking** sempre que viável. Operador visita menos locs físicas durante a wave, sem aumentar a dívida contábil entre empresas além do que o roteamento (no momento do webhook) já planejou.

Mini-swap é uma otimização **opt-in por galpão**, **graceful** (qualquer falha é absorvida — wave continua sem otimização), e **aditiva** (não muda nenhuma decisão de roteamento; só especifica em qual loc as decisões saem).

---

## 2. Contexto e motivação

### Realidade hoje

- Wave picking SISO (`/separacao`, status `em_separacao`) mostra **uma única localização por item** (texto livre vindo do Tiny, gravado em `siso_pedido_item_estoques.localizacao`).
- WMS (`siso_estoque`) é um modelo 4D com PK `(produto, empresa_dona, galpão, localização)`. Múltiplas rows podem existir pro mesmo SKU+galpão (diferentes empresas, diferentes locs).
- Roteamento (`src/lib/wms/roteamento.ts`) decide em modo shadow: pra cada pedido, calcula plano `própria | swap-inter-galpão | empréstimo`. Atualmente loga; após cutover, vai criar reservas e movs reais.

### Problema operacional

Quando duas ou mais empresas do mesmo grupo (ex: NetAir e NetParts) têm estoque do mesmo SKU no mesmo galpão (CWB), em locs diferentes, a wave picking tradicional força o operador a visitar múltiplas locs físicas para cumprir um único pedido.

Ex: pedido NetAir de 5 unidades do SKU `19FILTRO123` em CWB:
- NetAir tem 2 em A-03-02 + 1 em B-12-01 = 3 (própria)
- NetParts tem 5 em C-05-04 (irmã)
- Roteamento decide: NetAir 3 + empréstimo 2 da NetParts
- **Sem mini-swap:** operador visita A-03-02, B-12-01, C-05-04 = 3 locs

### Solução

Antes da wave começar, **trocar contábilmente** as unidades para consolidar tudo em 1 loc:
- Mini-swap (3 unidades): NetAir entrega 2 em A-03-02 + 1 em B-12-01 pra NetParts; NetParts entrega 3 em C-05-04 pra NetAir
- Empréstimo (2 unidades, mesma qty já decidida pelo roteamento): NetParts → NetAir em C-05-04
- **Resultado:** operador visita apenas C-05-04 (1 loc). Saldo devedor preservado em 2 (igual roteamento).

---

## 3. Decisões de design (com justificativas)

### 3.1 Quando dispara

**Decisão:** dentro de `POST /api/separacao/iniciar`, após transicionar pedidos para `em_separacao` e antes de retornar a checklist.

**Justificativa:** wave inteira é o nível natural de otimização. Já temos o conjunto completo de pedidos no input (`pedido_ids[]`), tem decisão de empresa picadora por pedido, contexto completo. Roda 1× por wave. Não atrasa o bipe (acontece antes do operador começar).

### 3.2 Mecanismo: híbrido swap + empréstimo

**Decisão:** mecanismo Z (híbrido). Tenta puro swap primeiro (zero dívida); se a empresa picadora não tem contrapartida total nas outras locs do galpão, complementa com empréstimo — **limitado ao que o roteamento já planejou**.

**Justificativa:**
- Espelha o padrão `roteamento.ts` (própria > swap > empréstimo)
- Sem nova dívida quando der pra evitar
- Garantia de progresso: sempre consolida em 1 loc se algum esquema for válido
- Preserva semântica do roteamento: o `qty_emprestimo` no mini-swap **nunca excede** o que o roteamento decidiu

### 3.3 Sem regra de governança pra mini-swap

**Decisão:** qualquer par de empresas no mesmo galpão pode fazer mini-swap. Não usa `siso_emprestimo_regras`.

**Justificativa:**
- Mini-swap é puramente contábil — não cria dívida nova além do que o empréstimo do roteamento já implica
- A parte de empréstimo do mini-swap só acontece se o roteamento já tinha planejado (e o roteamento usa `siso_emprestimo_regras`)
- Empresa NUNCA "sai prejudicada" pelo mini-swap (saldo total preservado, otimização recíproca ao longo do tempo)

### 3.4 Activation: toggle por galpão

**Decisão:** tabela `siso_wms_mini_swap_config(galpao_id PK, ativo bool)`, default ON ao seedar.

**Justificativa:** galpões podem estar em fases diferentes de adoção do WMS. Operação pode querer desativar pontualmente em um galpão pra validar comportamento. Granularidade por galpão é o sweet spot — não é over-engineering (vs por cargo, por curva ABC).

### 3.5 Falha = degradação graceful

**Decisão:** se RPC falhar (qualquer motivo), rollback total + log de erro + wave segue **sem otimização**. Operador picka multi-loc igual ao comportamento sem mini-swap.

**Justificativa:** mini-swap é **otimização**, não funcionalidade crítica. Wave nunca pode travar por causa dela. Se algo der errado, voltar ao baseline é seguro.

### 3.6 Reservas reconciliadas, não duplicadas

**Decisão:** RPC do mini-swap **cancela reservas existentes** (vindas do roteamento) na empresa contrapartida e **recria** na loc consolidada. Mesma `qty_emprestimo`, novo loc. Pedido_id preservado.

**Justificativa:** evita duplicação de empréstimo. O roteamento decidiu "NetParts empresta 2"; mini-swap decide "essas 2 saem em C-05-04". Mesma operação, loc especificada.

### 3.7 Auditoria via ledger existente

**Decisão:** sem UI nova específica. Movs já carregam `pedido_id` + `origem_tipo='swap'` no ledger (visível em `/wms/ledger`). Adicionar evento `mini_swap_executado` em `siso_pedido_historico` pra timeline do pedido.

**Justificativa:** reusa infraestrutura existente. Se aparecer dor real de "preciso ver swaps por wave", a gente adiciona view depois.

---

## 4. Arquitetura

### 4.1 Onde encaixa no fluxo

```
Operador seleciona pedidos → POST /api/separacao/iniciar
   │
   ├── 1. Validações de status (existente)
   ├── 2. Transição aguardando_separacao → em_separacao (existente)
   ├── ★ 3. NOVO: roda mini-swap (se ativo no galpão da operadora)
   │        │
   │        ├─ Lê config siso_wms_mini_swap_config[galpao_id].ativo
   │        ├─ Se ativo: chama RPC wms_executar_mini_swap(pedido_ids, galpao_id, usuario_id)
   │        ├─ Se RPC retorna plano não-vazio: registra evento histórico
   │        └─ Se RPC falha: log + segue sem otimização
   │
   └── 4. Retorna checklist consolidada (locs já refletem siso_estoque atualizado)
```

### 4.2 Componentes

| Componente | Tipo | Função |
|---|---|---|
| `wms_executar_mini_swap` | RPC PL/pgSQL | Executa o algoritmo, atômico, com lock pessimista |
| `siso_wms_mini_swap_config` | Tabela | Config por galpão (toggle on/off) |
| `/api/separacao/iniciar` | Mudança em route existente | Chama RPC após transição |
| `/api/wms/mini-swap/config` | Endpoint novo | GET/PATCH config |
| `/api/wms/mini-swap/simular` | Endpoint novo | Dry-run pra debug e visualização |
| `/wms/configuracoes/otimizacoes` | Página nova | UI de config (toggle por galpão) |

---

## 5. Algoritmo detalhado

### 5.1 Pseudocódigo

```
ENTRADA: pedido_ids[], galpao_id, usuario_id
SAÍDA: array de planos executados (jsonb)

1. SELECT FOR UPDATE em siso_estoque pra todos os SKUs envolvidos no galpão
   (lock pessimista — evita corrida com outras waves)

2. AGREGA por (empresa_picadora, sku, qty_total):
   - Pra cada pedido em pedido_ids: pra cada item: soma qty pendente
   - Resultado: lista de necessidades de picking pra wave inteira

3. PARA CADA (empresa_picadora E, sku S, qty_total Q):

   a. Conta locs do galpão onde E tem saldo > 0
      - Se = 1: skip esse SKU (já consolidado)

   b. Lê plano de empréstimo do roteamento:
      - qty_proprio_R = qty que E cobre com saldo próprio (somando todas locs)
      - qty_emprestimo_R = qty que outras empresas emprestam (= Q - qty_proprio_R)

   c. Lista locs candidatas L: locs do galpão onde alguma empresa F ≠ E tem saldo > 0

   d. Pra cada candidata L (loc onde existe ≥ 1 empresa ≠ E com saldo > 0):
      - saldo_F_L = saldo da empresa F com maior saldo em L (pra esse SKU)
        (v1: usa apenas a empresa com mais saldo em L como contrapartida.
         Multi-contrapartida fica pra otimização futura)
      - saldo_E_outras = soma do saldo de E em todas as locs do galpão ≠ L
      - qty_swap_max = min(saldo_E_outras, saldo_F_L)
      - capacidade_em_L = qty_swap_max + qty_emprestimo_R
      - Se capacidade_em_L >= Q E saldo_F_L >= (qty_swap_max + qty_emprestimo_R):
        → L é viável. Marca como melhor candidata. Ordena por: maior capacidade primeiro

   e. Se nenhuma L viável: skip esse SKU (sem otimização possível)

   f. Senão, executa plano em L (com a F escolhida em d):
      - Cancela reservas existentes da F nos pedido_ids
        (movs origem='reserva_pedido' não-estornadas pra esse SKU+F+galpão)
        via mov 'estorno' no ledger
      - Insere movs 'swap' — qty_swap_max no total:
          * Pra cada loc L_outra de E (≠ L) com saldo s_i (proporcional ao saldo total):
            qty_i = qty_swap_max * (s_i / saldo_E_outras)
            ↳ E saída qty_i em L_outra (origem='swap')
            ↳ F entrada qty_i em L_outra (origem='swap', par_de=mov anterior)
          * F saída qty_swap_max em L (origem='swap')
          * E entrada qty_swap_max em L (origem='swap', par_de=mov anterior)
      - Se qty_emprestimo_R > 0:
        * Insere mov 'reserva_pedido' (R) na quádrupla (S, E, galpao, L) pra qty_emprestimo_R
          ↳ devedora=E, credora=F
        * (Reserva vai ser convertida em saída na hora do bipe)

4. RETORNA jsonb com os planos executados (pra registrar em histórico)
```

### 5.2 Constraints/validações dentro da RPC

- `p_galpao_id` deve existir e estar ativo
- Cada pedido em `p_pedido_ids` deve estar em `em_separacao` (se mudou: skip silencioso)
- `qty_emprestimo` no plano executado **nunca** > `qty_emprestimo_R` calculada do roteamento (RAISE EXCEPTION se algoritmo violar)
- Saldo total de cada empresa preservado: `sum(saldo) por (empresa, galpao)` antes == depois (validado por trigger ou check pós-execução)
- Movs `swap` sempre em pares S+E iguais

### 5.3 Performance

- 1 SELECT FOR UPDATE no início agrupa lock por SKU+galpão
- Algoritmo principal é em-memória (PL/pgSQL)
- Movs inserção em batch (sub-RPC `wms_inserir_movimentacao` chamada N vezes por SKU)
- Esperado: <500ms pra wave de 50 pedidos com 100 SKUs únicos no caso típico

---

## 6. Schema de banco

### 6.1 Migration `supabase/migrations/20260514_wms_mini_swap.sql`

```sql
BEGIN;

-- 1. Tabela de configuração
CREATE TABLE IF NOT EXISTS siso_wms_mini_swap_config (
  galpao_id uuid PRIMARY KEY REFERENCES siso_galpoes(id) ON DELETE CASCADE,
  ativo boolean NOT NULL DEFAULT true,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_por uuid REFERENCES siso_usuarios(id)
);

-- 2. Seed: todos os galpões ativos com mini-swap on
INSERT INTO siso_wms_mini_swap_config (galpao_id, ativo)
SELECT id, true FROM siso_galpoes WHERE ativo = true
ON CONFLICT (galpao_id) DO NOTHING;

-- 3. RPC wms_executar_mini_swap
CREATE OR REPLACE FUNCTION wms_executar_mini_swap(
  p_pedido_ids uuid[],
  p_galpao_id uuid,
  p_usuario_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_planos jsonb := '[]'::jsonb;
  -- ... estado interno
BEGIN
  -- Lock pessimista
  PERFORM 1 FROM siso_estoque
  WHERE galpao_id = p_galpao_id
    AND produto_id IN (
      SELECT DISTINCT pi.produto_id
      FROM siso_pedido_itens pi
      WHERE pi.pedido_id = ANY(p_pedido_ids)
    )
  FOR UPDATE;

  -- ... algoritmo (ver seção 5.1)

  RETURN v_planos;
END;
$$;

COMMENT ON FUNCTION wms_executar_mini_swap IS
  'Mini-swap intra-galpão: consolida picking em 1 loc por SKU. Roda no início da wave (/api/separacao/iniciar). Atômico.';

COMMIT;
```

### 6.2 Sem alteração em schemas existentes

`origem_tipo='swap'` já existe (Plano 4 — `20260513_wms_swap.sql`). Reusamos.
`siso_movimentacoes` não muda.
`siso_estoque` não muda.

---

## 7. Mudanças em APIs

### 7.1 Mudança em `POST /api/separacao/iniciar`

Após o bloco que transiciona pedidos pra `em_separacao`, antes de construir a checklist:

```ts
// ─── NOVO: mini-swap ───
const { data: config } = await supabase
  .from("siso_wms_mini_swap_config")
  .select("ativo")
  .eq("galpao_id", session.galpaoId)
  .maybeSingle();

if (config?.ativo) {
  try {
    const { data: planos, error: rpcError } = await supabase.rpc(
      "wms_executar_mini_swap",
      {
        p_pedido_ids: pedido_ids,
        p_galpao_id: session.galpaoId,
        p_usuario_id: session.id,
      },
    );

    if (rpcError) throw rpcError;

    if (Array.isArray(planos) && planos.length > 0) {
      // Registra evento por pedido afetado
      const eventos = pedido_ids.map((pid) => ({
        pedido_id: pid,
        evento: "mini_swap_executado",
        detalhes: { planos },
        usuario_id: session.id,
      }));
      await registrarEventos(eventos); // fire-and-forget
    }
  } catch (err) {
    logger.logError({
      source: "mini-swap",
      message: "RPC wms_executar_mini_swap falhou",
      category: "database",
      error: err,
      metadata: { pedido_ids, galpao_id: session.galpaoId },
    });
    // Segue o fluxo SEM otimização — wave continua normal
  }
}
// ─── FIM mini-swap ───
```

A checklist construída em seguida vai naturalmente ler de `siso_estoque` atualizado.

### 7.2 Endpoints novos

| Endpoint | Método | Auth | Body | Retorno |
|---|---|---|---|---|
| `/api/wms/mini-swap/config` | GET | Session | — | `[{ galpao_id, galpao_nome, ativo, atualizado_em, atualizado_por_nome }]` |
| `/api/wms/mini-swap/config/[galpaoId]` | PATCH | Admin | `{ ativo: bool }` | `{ ok: true }` |
| `/api/wms/mini-swap/simular` | POST | Session | `{ pedido_ids, galpao_id }` | `{ planos: [...] }` (não executa, dry-run) |

---

## 8. UI

### 8.1 Página nova: `/wms/configuracoes/otimizacoes`

- Acessível via link "Otimizações" em `/wms/configuracoes` (aba ou subpágina)
- Layout: tabela de galpões
  - Coluna: nome do galpão
  - Coluna: toggle on/off (componente switch)
  - Coluna: última alteração (timestamp + usuário)
- Persiste via PATCH em `/api/wms/mini-swap/config/[galpaoId]`
- Toast de sucesso ao salvar

Quando o cycle count oportunista for implementado (próximo spec), ele entra na mesma página com toggle adicional por galpão.

### 8.2 Sem mudança nas telas de picking

A checklist já consome `siso_estoque` (via API existente), então as locs otimizadas aparecem automaticamente. Operador não precisa saber que mini-swap rodou — só vai ver menos locs.

### 8.3 Histórico do pedido (`/pedidos/[id]`)

Timeline ganha entrada `mini_swap_executado` (via `siso_pedido_historico`):

```
14:32:01 — Mini-swap executado
  • SKU 19FILTRO123 → consolidado em C-05-04
    (swap: 3 unidades, empréstimo: 2 unidades)
```

---

## 9. Edge cases

| Caso | Comportamento |
|---|---|
| Mini-swap desativado no galpão | Skip total. Wave segue como hoje |
| WMS sem rows pra esse SKU/galpão | Skip pra esse SKU. Continua outros |
| Empresa picadora já em 1 loc só | Skip esse SKU (nada a otimizar) |
| Nenhuma loc candidata viável | Skip esse SKU. Operador picka multi-loc |
| Lock em `siso_estoque` (concorrência) | RPC espera (FOR UPDATE) |
| RPC falha (qualquer erro) | Rollback + log + wave segue sem otimização |
| Pedido com `compra_status` pendente | Skip (mini-swap só vê pedidos em `em_separacao`) |
| `qty_emprestimo` não cabe nos limites | Skip esse SKU. Roteamento já validou limite, então não deveria acontecer — mas defesa em profundidade |
| Saldo F em L muda entre seleção e execução | Lock FOR UPDATE no início garante consistência |
| Pedido cancelado durante execução | Reservas do pedido são canceladas via fluxo normal (cancelamento de pedido). Mini-swap não interfere |

---

## 10. Testes

### 10.1 Unit (RPC `wms_executar_mini_swap`)

| Caso | Assert |
|---|---|
| 1 loc só pra empresa picadora | RPC retorna `[]` (skip) |
| Pure swap viável (E tem contrapartida total) | Apenas movs `swap`. `qty_emprestimo=0` |
| Hybrid swap + empréstimo | Mix de movs `swap` + `reserva_pedido`. `qty_emprestimo` ≤ planejado |
| Inviável (nenhuma loc cabe Q total) | RPC retorna `[]` (skip) |
| Múltiplas empresas em L (3+ no mesmo galpão) | Soma saldos, swap usa a mais cheia primeiro |
| Saldo total preservado | sum(saldo) por (empresa, galpao) = igual antes/depois |
| qty_emprestimo > planejado | EXCEPTION (defensa) |

### 10.2 Integração (`/api/separacao/iniciar`)

| Caso | Assert |
|---|---|
| Wave de 5 pedidos com SKU comum, mini-swap aplica | Checklist mostra loc consolidada. Histórico tem evento |
| Mini-swap desativado no galpão | RPC não chamada. Comportamento igual hoje |
| RPC retorna erro | Wave continua. Log gerado em `siso_erros` |
| Wave com 0 oportunidades de mini-swap | RPC retorna `[]`. Nenhum evento histórico |

### 10.3 Concorrência

| Caso | Assert |
|---|---|
| 2 waves simultâneas tocando mesmo SKU+galpão | Segunda espera. Resultado final consistente |
| Wave + ajuste manual no mesmo SKU/galpão | Lock FOR UPDATE serializa. Ajuste espera ou wave espera |

### 10.4 E2E (staging)

- Setup: 2 pedidos NetAir + NetParts em CWB com SKU 19TEST123 espalhado
- Iniciar wave
- Validar via API que checklist tem 1 loc só
- Validar via `/wms/ledger` que movs `swap` foram criadas
- Validar via `/wms/estoque` que saldos consolidaram

---

## 11. Não-objetivos / fora de escopo

Pra deixar a spec focada, **estes pontos NÃO entram nessa feature** (vão pra outros specs ou backlog):

| Não-objetivo | Por quê |
|---|---|
| Mini-swap inter-galpão | Já existe (`wms_executar_swap` no Plano 4) |
| Operador escolher loc no momento do bipe | Mudança de UX da wave picking — feature separada |
| Auditoria avançada de mini-swap (dashboard, filtro por wave) | Reusamos `/wms/ledger` por ora. Aparecer dor → nova feature |
| Mini-swap reduzindo locs **parcialmente** (ex: de 3 pra 2) | Só consolida 100% (em 1 loc) ou skip. Otimização parcial vai gerar UX confusa ("ainda visito 2 locs em vez de 3?") |
| Mini-swap entre empresas de **grupos diferentes** | Mini-swap é puramente contábil mas operacionalmente faz mais sentido entre irmãs do mesmo grupo. Algoritmo não filtra por grupo (porque não cria dívida nova) — se aparecer caso edge negativo, adicionamos filtro |
| **Multi-contrapartida** (combinar saldo de N empresas em L) | v1 usa apenas a empresa com maior saldo em L. Casos onde N empresas pequenas em L poderiam combinar pra cobrir Q vão pra otimização futura. Espera-se ser raro (pares NetAir↔NetParts cobrem 99% do volume) |
| Cycle count oportunista | Spec separada, **depende deste**. Quando mini-swap estiver estável, retomamos com escopo simples (lookup WMS já garantido pelo mini-swap) |
| Telemetria de quanto mini-swap economizou (locs evitadas, tempo) | Métrica futura. Por ora, evento histórico é suficiente |

---

## 12. Spec follow-up: cycle count oportunista

Esta spec é foundation pra cycle count oportunista. Retomar quando mini-swap estiver em produção e estável.

**Resumo do que ficou decidido pra cycle count** (pra não perder contexto):

- **Trigger:** durante wave picking, no momento `item_completo` da onda inteira (não por pedido), quando:
  - SKU tem ≤ N unidades na loc (configurável por galpão, default 5)
  - Loc não tem contagem em ≥ M dias (configurável por galpão, default 30)
- **Mecanismo:** operador conta unidades restantes; sistema aplica direto como ajuste no ledger (origem=`cycle_count_oportunista`). Sem bloqueio.
- **Config:** mesma página `/wms/configuracoes/otimizacoes`, com toggle + thresholds por galpão.
- **Lookup WMS:** vai usar a loc canônica garantida pelo mini-swap (cada (empresa, galpão, SKU) tem 1 loc no momento do bipe), simplificando muito o algoritmo.

---

## 13. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Mini-swap atrasa início da wave (RPC lenta) | Lock pessimista é apenas no SKU+galpão da wave. Esperado <500ms. Se passar disso, adicionamos timeout e degradação graceful |
| Bug no algoritmo aumenta dívida indevidamente | Validação dentro da RPC (raise se `qty_emprestimo > planejado`). Conservação de saldo total verificada |
| Movs `swap` poluem ledger pra debugging | Filtro por `origem_tipo` em `/wms/ledger` já existe |
| Operador estranha quando vê empresa diferente "dona" do estoque | UI da picking não mudou. Operador só vê loc — quem é dono é detalhe contábil |
| Mini-swap acontece mas pedido depois é cancelado | Movs swap não são revertidas (saldos das empresas continuam corretos). Apenas a reserva criada é cancelada (fluxo normal de cancelamento) |

---

## 14. Roadmap de implementação (high-level)

Detalhamento exato vai pro plano (próxima etapa via writing-plans).

1. Migration `20260514_wms_mini_swap.sql` (tabela config + RPC vazia + seed)
2. Implementar algoritmo dentro da RPC (TDD com casos da seção 10.1)
3. Endpoints `/api/wms/mini-swap/config` + `/simular`
4. Página `/wms/configuracoes/otimizacoes` (toggle por galpão)
5. Mudança em `/api/separacao/iniciar` (chamada da RPC, error handling, evento histórico)
6. Linha de timeline `mini_swap_executado` em `/pedidos/[id]`
7. Testes E2E em staging (Supabase `ehbxpbeijofxtsbezwxd`)
8. Atualizar docs (CLAUDE.md, api-reference-complete.md, database-schema.md, architecture-and-flows.md)
9. Cutover pra prod com feature flag (toggle off em todos os galpões inicialmente, ativar 1 a 1)
