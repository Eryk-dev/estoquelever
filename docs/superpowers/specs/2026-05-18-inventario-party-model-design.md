# WMS · Inventário · Modelo Party (substituição dos slots numerados)

**Data:** 2026-05-18
**Status:** Design aprovado, pronto pra plano de implementação
**Escopo:** Substitui o modelo "slots numerados OP1..OP5" do inventário por modelo "party" — lista dinâmica de operadores ativos, sem cap rígido e sem identidade fixa por número.

---

## 1. Contexto e motivação

### Modelo atual ("slot numerado")

Hoje o módulo de inventário trata operadores como **5 slots fixos** (`OP1..OP5`):

- `siso_inventario_operadores.slot smallint CHECK BETWEEN 1 AND 5` + `UNIQUE(sessao_id, slot)`.
- `siso_inventario_sessoes.num_operadores smallint DEFAULT 5` — supervisor configurava (1..5) ao criar.
- Tela handheld (`/wms/inventario/[id]/contar`) apresenta um **SlotPicker**: operador precisa escolher um número de slot livre antes de começar.
- Painel do supervisor (`/wms/inventario/[id]`) renderiza uma grade fixa OP1..OP{num_operadores} — slots vazios aparecem como placeholders.
- RPC `wms_inventario_proxima_loc` (versão `20260513_wms_inventario_claim_hierarquico.sql`) **já não usa `slot`** internamente — opera por `usuario_id`. Mensagem de erro ainda menciona "slot ativo".
- `siso_inventario_localizacoes.slot_atribuido` **já foi dropada** em `20260513_wms_inventario_claim_hierarquico.sql` (era do modelo bucketing curto-lived). Reforça que `slot` em operadores virou puramente UI.

### Problemas

1. **Identidade artificial:** "OP3" não é a Maria — é uma cadeira numerada. Se Maria sai e Carlos entra no mesmo número, fica confuso ("OP3 contou 12 locs" — quem contou?). A identidade real é o usuário, não o slot.
2. **Cap rígido:** sessão grande com 7 operadores disponíveis trava nos 5 slots por DB. Não há razão de negócio pra isso — é resquício do modelo antigo de bucketing, abandonado em `20260513`.
3. **Fricção no handheld:** SlotPicker é uma tela a mais (1 clique extra + cognição "qual slot?"). Inútil agora que slot é irrelevante pro algoritmo de roteamento.
4. **`num_operadores` é ornamental:** após o commit `a0b0063` (que removeu seletor "Operadores esperados" do modal), vira só limitador visual sem propósito — coluna morta com semântica perdida.
5. **Mensagem de erro confusa:** RPC ainda diz "não está em nenhum slot ativo" quando user não está na sessão — terminologia velha.

### Mental model alvo: party de jogo online

- Operador entra → vira "mais um na party". Sem escolher número, sem alocação.
- Lista cresce/encolhe em realtime conforme gente entra e sai.
- Identidade = usuário (`Maria · 12 locs`, `João · 8 locs`).
- Sem limite hard: 3, 5, 7 operadores trabalham juntos sem o sistema reclamar.
- Sair e voltar **retoma** o registro (mesma Maria, ainda com 12 locs já contadas).

### Decisões resolvidas no brainstorm

| Pergunta | Decisão |
|---|---|
| Que comportamento de "assumir contagem de algum ponto"? | **Pegar próxima loc do pool, como hoje.** Roteamento via claim hierárquico continua intocado. Não introduzimos "roubar loc parcial de quem saiu". |
| Visual da party? | **Lista dinâmica pura, sem número e sem cap.** Anônimo até alguém entrar, cresce conforme entram. Sem hint de capacidade. |
| Reentrada (Maria sai e volta)? | **Retoma registro existente.** Mesma linha em `operadores`, `locs_contadas` continua acumulando. |

---

## 2. Visão geral da solução

Um pacote único de mudanças em 5 camadas, encadeadas:

```
┌──────────────────────────────┐
│ Migration (drop + add col)   │  ← seção 3
└────────────┬─────────────────┘
             │
┌────────────▼─────────────────┐
│ RPC wms_inventario_proxima_loc │  ← seção 4 (drop v_meu_slot)
│   reescrita                  │
└────────────┬─────────────────┘
             │
┌────────────▼─────────────────┐
│ Service src/lib/wms/         │  ← seção 5
│   inventario.ts              │
│   (entrarParty/sairParty)    │
└────────────┬─────────────────┘
             │
┌────────────▼─────────────────┐
│ API routes /api/wms/         │  ← seção 6
│   inventario/[id]/slots(/*)  │  → renomear pra /party
└────────────┬─────────────────┘
             │
┌────────────▼─────────────────┐
│ Frontend                     │  ← seção 7
│   /contar (handheld)         │
│   /[id]    (supervisor)      │
└──────────────────────────────┘
```

Não é uma feature nova — é uma **refatoração de modelo** que simplifica código existente. Mais código será deletado do que adicionado.

---

## 3. Schema (DB)

### Migration: `supabase/migrations/20260518_wms_inventario_party_model.sql`

```sql
BEGIN;

-- ───────────────────────────────────────────────────────────────────────
-- 1. Drop: slot numerado de operador
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE siso_inventario_operadores
  DROP CONSTRAINT IF EXISTS siso_inventario_operadores_slot_check;

ALTER TABLE siso_inventario_operadores
  DROP CONSTRAINT IF EXISTS siso_inventario_operadores_sessao_id_slot_key;

ALTER TABLE siso_inventario_operadores
  DROP COLUMN IF EXISTS slot;

-- ───────────────────────────────────────────────────────────────────────
-- 2. Drop: num_operadores da sessão
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE siso_inventario_sessoes
  DROP CONSTRAINT IF EXISTS siso_inventario_sessoes_num_operadores_check;

ALTER TABLE siso_inventario_sessoes
  DROP COLUMN IF EXISTS num_operadores;

-- ───────────────────────────────────────────────────────────────────────
-- 3. Add: ultima_reentrada_em pra auditar reentradas na party
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE siso_inventario_operadores
  ADD COLUMN IF NOT EXISTS ultima_reentrada_em timestamptz NULL;

-- O UNIQUE parcial (sessao_id, usuario_id) WHERE finalizado_em IS NULL
-- já existe (idx uq_inv_op_user_ativo do rewrite.sql) e continua sendo a
-- única defesa contra duplicação ativa. Reentrada atualiza a linha
-- existente (vide service), nunca insere outra.

-- NOTA: siso_inventario_localizacoes.slot_atribuido já foi dropada em
-- 20260513_wms_inventario_claim_hierarquico.sql — não há nada a fazer aqui.

COMMIT;
```

### Estado final da `siso_inventario_operadores`

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | uuid PK | — |
| `sessao_id` | uuid FK | — |
| `usuario_id` | uuid FK | — |
| `entrou_em` | timestamptz | Primeira entrada na sessão (não atualiza em reentrada) |
| `finalizado_em` | timestamptz NULL | NULL = ativo na party; NOT NULL = saiu |
| `ultima_reentrada_em` | timestamptz NULL | **Novo.** Setada toda vez que reentra (NULL na primeira entrada) |
| `locs_contadas` | int | Acumulado da sessão (não zera em reentrada) |
| `ultima_acao_em` | timestamptz | Atualizada em cada pegarProximaLoc |
| `claim_tipo` | text NULL | rua \| predio \| colisao \| NULL |
| `claim_codigo` | text NULL | 'A' (rua) ou 'A-03' (prédio/colisao) |
| `claim_direcao` | text NULL | asc \| desc |
| `claim_atualizado_em` | timestamptz NULL | — |

Trigger BEFORE UPDATE que limpa `claim_*` quando `finalizado_em` é setado **continua existindo** — relevância intacta.

### Sem migração de dados

Como o ambiente é staging e foi explicitado no `wms_inventario_rewrite.sql` que não preservamos sessões antigas, **drop direto sem backfill**.

---

## 4. RPC `wms_inventario_proxima_loc`

Versão atual está em `20260513_wms_inventario_claim_hierarquico.sql`. Internamente **já não usa `slot`** — opera por `usuario_id`. A única mudança necessária é cosmética: trocar a mensagem de erro pra refletir a terminologia "party".

### Mudança

Linha atual:
```sql
RAISE EXCEPTION 'usuário não está em nenhum slot ativo desta sessão';
```

Vira:
```sql
RAISE EXCEPTION 'usuário não está na party desta sessão';
```

A migration `20260518` faz `CREATE OR REPLACE FUNCTION wms_inventario_proxima_loc(...)` com o corpo da versão claim_hierarquico e só essa string trocada. Como `CREATE OR REPLACE` substitui inteira, o arquivo da migration tem que reproduzir o corpo completo da função (não há `ALTER FUNCTION` que mude só uma string).

### Mantém intocado

- Validação de presença via `siso_inventario_operadores` (já é por `usuario_id`).
- Algoritmo de claim hierárquico (rua > prédio > buffer > colisão).
- Lock atômico `FOR UPDATE OF inv_loc SKIP LOCKED`.
- Payload (`inv_loc_id`, `loc_id`, `codigo`, `tipo`, `zona`, `modo`, `esperados`, `claim_tipo`, `claim_codigo`, `claim_direcao`).

### Resultado

Comportamento idêntico. Só a mensagem de erro fica mais consistente com o resto do código novo.

---

## 5. Service layer (`src/lib/wms/inventario.ts`)

### Renomeação semântica

| Antes | Depois |
|---|---|
| `entrarSlot(sessaoId, slot, usuarioId)` | `entrarParty(sessaoId, usuarioId)` |
| `sairSlot(sessaoId, usuarioId)` | `sairParty(sessaoId, usuarioId)` |

`sairParty` não muda comportamento (já era por user, não por slot — só seta `finalizado_em`).

### `entrarParty` — upsert idempotente com retomada

```ts
export async function entrarParty(
  sessaoId: string,
  usuarioId: string,
): Promise<{ retomado: boolean }> {
  const sb = createServiceClient();

  // Auto-start: se sessão tá planejada, inicia (idempotente)
  await iniciarSessao(sessaoId, usuarioId);

  // Existe registro deste usuário nesta sessão? (ativo ou finalizado)
  const { data: existente } = await sb
    .from("siso_inventario_operadores")
    .select("id, finalizado_em")
    .eq("sessao_id", sessaoId)
    .eq("usuario_id", usuarioId)
    .maybeSingle();

  if (existente) {
    if (existente.finalizado_em === null) {
      // Já está na party — idempotente
      return { retomado: false };
    }
    // Reentrada: reativa registro, marca timestamp pra UI
    const { error } = await sb
      .from("siso_inventario_operadores")
      .update({
        finalizado_em: null,
        ultima_reentrada_em: new Date().toISOString(),
        ultima_acao_em: new Date().toISOString(),
      })
      .eq("id", existente.id);
    if (error) throw error;
    return { retomado: true };
  }

  // Primeira entrada
  const { error } = await sb.from("siso_inventario_operadores").insert({
    sessao_id: sessaoId,
    usuario_id: usuarioId,
  });
  if (error) throw error;
  return { retomado: false };
}
```

**Notas**:
- Sem `slot` no insert — coluna não existe mais.
- Idempotência total: chamar 2x seguidas com mesmo user não falha nem duplica.
- Reentrada preserva `locs_contadas` (não tocada no UPDATE).
- `entrou_em` não é alterada na reentrada — fica congelada na primeira vez (auditoria histórica).
- Trigger BEFORE UPDATE que limpa `claim_*` ao setar `finalizado_em` **não dispara aqui** (estamos zerando finalizado_em, não setando) — claims que ficaram da sessão anterior são limpos quando ela saiu, então a reentrada começa "limpa".

### `criarSessao` — limpeza

Remove parsing de `input.num_operadores`. O parâmetro some da interface `CriarSessaoInput`. Sessões criadas via API/UI não precisam mais informar quantos operadores virão.

### `finalizarLoc` e demais funções

Sem mudança — já operam por `usuario_id`, não por slot.

### Cleanup de imports/tipos

`Operador` (type retornado por queries) deixa de ter `slot: number`. Todos os locais que renderizam `OP{slot}` mudam pra `usuario.nome ?? "Operador"`.

---

## 6. API routes

### Renomeação

| Antes | Depois |
|---|---|
| `POST /api/wms/inventario/[id]/slots/[slot]/entrar` | `POST /api/wms/inventario/[id]/party` |
| `DELETE /api/wms/inventario/[id]/slots` | `DELETE /api/wms/inventario/[id]/party` |

A rota antiga aceitava `[slot]` como path param — vai embora. Cliente não precisa mais escolher.

### Estrutura de arquivos

**Deleta:**
- `src/app/api/wms/inventario/[id]/slots/route.ts`
- `src/app/api/wms/inventario/[id]/slots/[slot]/route.ts`

**Cria:**
- `src/app/api/wms/inventario/[id]/party/route.ts` (POST + DELETE no mesmo arquivo)

### Contratos

```ts
// POST /api/wms/inventario/[id]/party
// Auth: usuário logado (qualquer cargo com warehouse access)
// Body: vazio
// Response 200: { ok: true, retomado: boolean }
// - retomado=true significa "voltou pra sessão, locs_contadas preservadas"
// - retomado=false significa "primeira entrada"

// DELETE /api/wms/inventario/[id]/party
// Auth: usuário logado
// Response 200: { ok: true }
// Comportamento idêntico ao sairSlot atual.
```

### Side effect: docs

`docs/api-reference-complete.md` precisa de update (remove rotas `/slots`, adiciona `/party`). Mesmo commit da migration.

---

## 7. Frontend

### 7.1 Handheld (`src/app/wms/inventario/[id]/contar/page.tsx`)

**Remove:**
- Componente `SlotPicker` inteiro (~85 linhas, função `function SlotPicker(...)`).
- `Etapa = "slot-picker" | ...` — primeira etapa vira `"entering"` (loading enquanto chama `entrarParty`).
- Lookup de `meuSlot` (já existe via `operadores.find(o => o.usuario_id === user.id)` — mantém como `meuOp`).

**Adiciona:**
- Ao montar, se usuário não está na party (não há `op` ativo com seu `usuario_id`), chama `POST /party` automaticamente. Mostra spinner "Entrando na party…".
- Após entrada (ou se já estava dentro), vai direto pra etapa **standby**.

**Mudanças visuais:**
- Header standby vira `Você está na party · ${meuOp.locs_contadas} loc(s) contada(s)${retomado ? " (retomado)" : ""}`. O sufixo "(retomado)" aparece por 5s e some.
- Botão "Sair do slot" vira "Sair da party". Texto do confirm: "Sair da party? Locs em contagem ficam liberadas pra cleanup."
- "Entrou como OP{slot}" → "Entrou na party".

### 7.2 Supervisor (`src/app/wms/inventario/[id]/page.tsx`)

**Remove:**
- Grade fixa `Array.from({ length: num_operadores }, …).map(slot => <SlotCard slot={slot} op={op} ... />)`.
- Header `· N configurado(s)`.

**Adiciona:**
- Lista dinâmica de operadores ativos: `operadores.filter(o => o.finalizado_em === null).map(op => <ParticipanteCard op={op} ... />)`.
- Empty state: se não há ninguém ativo, mostra `"Ninguém na party ainda. Aguardando primeiro operador."`.

**Renomeação:** `SlotCard` → `ParticipanteCard`. Conteúdo:
- Antes: `<strong>OP{slot}</strong>` + nome + locs_contadas + claim.
- Depois: `<strong>{op.usuario.nome}</strong>` + claim + locs_contadas + (se `ultima_reentrada_em`) "voltou às HH:MM".

Tamanho de card e layout (grid `auto-fit minmax(180px, 1fr)`) mantidos — UX visual quase idêntica, só sem placeholders vazios.

### 7.3 Modal de criação de sessão (`src/app/wms/inventario/page.tsx`)

Já não tem campo "Operadores esperados" desde `a0b0063`. Confirmação: nenhuma mudança visual necessária. Só remover referências internas a `num_operadores` no submit, se houver.

### 7.4 Hook de realtime (`src/hooks/use-inventario-realtime.ts`)

Tipo `Operador` perde `slot: number`, ganha `ultima_reentrada_em: string | null`. Subscription continua igual (mesma tabela).

---

## 8. Limpeza / consequências

### Arquivos deletados

- `src/app/api/wms/inventario/[id]/slots/route.ts`
- `src/app/api/wms/inventario/[id]/slots/[slot]/route.ts`

### CLAUDE.md

Bloco `siso_inventario_operadores` precisa atualizar:
- Remove "Slots OP1..OP5 dinâmicos: slot smallint (1-5)".
- Adiciona: "Party model — N operadores ativos por sessão, sem slot numerado. UNIQUE parcial (sessao_id, usuario_id) WHERE finalizado_em IS NULL evita duplicação."

Bloco `siso_inventario_sessoes`: remove `num_operadores`.

Bloco "WMS Plano 4 v2 (Inventário pull queue + slots)": atualiza nome pra "Inventário pull queue + party model" e adiciona nota de migração 2026-05-18.

### Docs

- `docs/api-reference-complete.md`: substitui rotas `/slots` por `/party`.
- `docs/database-schema.md`: atualiza colunas de `siso_inventario_operadores`, `siso_inventario_sessoes`, `siso_inventario_localizacoes`.
- `docs/architecture-and-flows.md`: se mencionar "slot picker" no fluxo de inventário, atualizar.

### `erros-conhecidos.yaml`

Não há erro a registrar (essa não é correção de bug — é refactor de modelo).

---

## 9. Estratégia de testes

### Unit (vitest)

Novo arquivo `src/lib/wms/inventario-party.test.ts` (ou estende existente):

1. **Entrada nova**: `entrarParty(sessao, user1)` → cria linha, `retomado: false`.
2. **Entrada idempotente**: chamada 2x seguidas com mesmo user → não duplica, segunda retorna `retomado: false`.
3. **Reentrada**: `entrarParty` → `sairParty` → `entrarParty` → reusa linha, `retomado: true`, `ultima_reentrada_em` setada, `locs_contadas` preservada.
4. **Múltiplos operadores**: 3 users entram → 3 linhas ativas, sem conflito de UNIQUE.
5. **Sem cap rígido**: 7 users entram → 7 linhas ativas (antes ia falhar no CHECK do slot).

### Manual / staging

1. Abrir sessão em staging com 1 operador → handheld pula picker, vai direto pra standby.
2. Operador conta 3 locs, sai, volta → standby mostra "(retomado)", contagem em 3 (não zerada).
3. Abrir handheld em 2 dispositivos com users diferentes → ambos entram, supervisor vê 2 cards lado a lado.
4. RPC `wms_inventario_proxima_loc`: cada operador puxa próxima loc, claim hierárquico continua funcionando (rua/prédio/colisão) — verificar painel do supervisor mostrando claims.

### Regressão

- Sessão "completo" com pool de 50+ locs e 5 operadores simultâneos → distribuição funciona, sem operador ocioso.
- Encerrar sessão parcial → operadores ativos finalizados, claims limpos pelo trigger.
- Aprovar sessão e aplicar divergências → fluxo continua igual, sem dependência de slot.

---

## 10. Migration & rollout

### Ordem de aplicação (1 PR)

1. Migration SQL (`20260518_wms_inventario_party_model.sql`) — drop colunas + RPC reescrita.
2. Service (`src/lib/wms/inventario.ts`) — `entrarParty`/`sairParty`, remove `num_operadores` de `criarSessao`.
3. API routes — deleta `/slots/*`, cria `/party`.
4. Frontend — handheld + supervisor.
5. Docs (CLAUDE.md, api-reference-complete, database-schema).
6. Testes unitários.

Tudo no mesmo commit/PR — não há ponto intermediário coerente (mudança de schema sem mudança de service deixa app quebrado).

### Rollback

Como é staging sem dados a preservar, rollback = reverter o commit + rodar migration de reversão manual (recriar colunas drop). Spec não inclui migration de reversão por escolha (custo > benefício no staging).

### Risco

Baixo. Nenhuma rota usada por sistema externo (webhook, cron) — `/slots` é interno de UI. RPC é chamada só pelo service. Drop de colunas em staging é seguro.

---

## 11. Critérios de sucesso

- [ ] Handheld abre sem SlotPicker. Operador entra na party com 0 cliques (auto), 1 clique pra "Próxima loc".
- [ ] Maria sai, volta, contagem dela continua de 12 (não zera pra 0).
- [ ] Supervisor vê lista de quem está dentro — cresce/encolhe com realtime.
- [ ] 7 operadores conseguem entrar simultaneamente (antes travava em 5).
- [ ] RPC continua entregando próxima loc com claim hierárquico (rua/prédio/colisão), sem regressão de roteamento.
- [ ] Schema final tem `siso_inventario_operadores` sem `slot`, `siso_inventario_sessoes` sem `num_operadores`, `siso_inventario_localizacoes` sem `slot_atribuido`.
- [ ] Sem referências a "OP1/OP2/OP{n}" em código ou UI (a menos que seja string de erro de log antiga — mas mensagens novas dizem "party").

---

## 12. Fora de escopo

- **Roubar loc parcial de quem saiu**: decidido no brainstorm — não fazemos. Roteamento continua via pull queue.
- **Tabela `siso_inventario_presencas`**: auditoria rica de entradas/saídas. YAGNI por agora. `ultima_reentrada_em` cobre o suficiente.
- **Hint visual de capacidade**: nada do tipo "3 na party (recomendado: 5)". Lista é pura.
- **Migração de sessões antigas**: staging não preserva.
