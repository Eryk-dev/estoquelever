# Inventário com operação viva — fixes (refresh/retomada + furos de lock + aplicação×reserva)

**Data:** 2026-06-12
**Origem:** investigação a fundo do módulo de inventário (bug reportado: refresh no meio da contagem pula pra próxima loc).

> **STATUS: EXECUTADO em 2026-06-12** (todas as fases, decisões D1/D2/D3 = recomendações).
> - Fase 1 → migration `20260612_inventario_proxima_loc_retomada.sql` [INV-05] — aplicada no staging.
> - Fase 2 → `lib/wms/loc-locks.ts` + filtros em realocacao-resolver / wms-mapping / putaway [INV-07].
> - Fase 3.1 **já existia** (preflight INV-02/04 em `20260611e`); executado só o 3.2 (badge `colide_reserva` no GET + UI).
> - Fase 4 → migration `20260612b_loc_locks_sessao_id.sql` [INV-06] + órfãs antes do computar [INV-08] — aplicada no staging.
> - Descoberta extra corrigida no 4.2: em modo PARCIAL, bipes de locs `em_contagem` entravam no cálculo sem saldo carregado → ganho fantasma (filtro de contagens por locIds).
> - Entradas em `erros-conhecidos.yaml`: `INVENTARIO-REFRESH-PULA-LOC`, `INVENTARIO-OPERACAO-FUROS-LOCK`.

---

## Veredito da investigação

**O conceito "contar com a operação rodando" FUNCIONA no núcleo.** A arquitetura tem 3 camadas que se sustentam:

1. **Locks soft** (`siso_localizacao_locks`, criados em `iniciarSessao` pra todas as locs da sessão): tiram as locs do roteamento de pedidos novos (`roteamento.ts:261`), da sugestão de picking (`sugestao-dinamica.ts:102`) e do reconciliador-OC (`reconciliador-oc.ts:178`). Operação **não para** — só desvia das locs em contagem.
2. **Reconciliação temporal** (`inventario-reconciliacao.ts`): movs que acontecem mesmo assim (picks de reservas pré-existentes, put-away, recebimento) são absorvidos. Por tripla, `saldo_esperado = saldo_anterior` da primeira mov efetiva após o último bipe (`t_ref`). Matemática verificada em todos os cenários de interleaving (pick antes/depois do bipe, put-away durante sessão, estornos, loc visitada vazia) — **correta**.
3. **Aplicação por DELTA** (`wms_aplicar_sessao_inventario`): aplica E/S do delta sobre o saldo ATUAL, não valor absoluto. Movs entre contagem e aplicação não corrompem o resultado.

**Mas há 3 furos reais + 1 bug P0 (o do refresh):**

| # | Severidade | Furo |
|---|---|---|
| F1 | **P0** | Refresh perde a loc: `wms_inventario_proxima_loc` não tem fase de retomada — claim novo sempre. Loc antiga fica órfã `em_contagem` 30min até o recovery **descartar os bipes** (trabalho perdido + recontagem). |
| F2 | **P1** | Cascade do pick parcial (`realocacao-resolver.ts`, `buscarLocComMaiorSaldoNoGalpao`) e sugestão de put-away (`putaway.ts:78`) **não filtram locks** — criam R nova / mandam gente pra dentro de loc em contagem. Contradiz o padrão P3-26 dos outros 3 consumidores. |
| F3 | **P1** | Aplicar perda numa loc com **reserva viva** que excede o saldo pós-perda viola `CHECK (reservado <= saldo)` → **rollback total da sessão** (tudo-ou-nada). Supervisor não tem diagnóstico — sessão fica eternamente inaplicável até alguém descobrir e rejeitar a divergência na mão. |
| F4 | P2 | Locks seguram até a **aprovação da sessão inteira**: loc já finalizada (`contada`) continua fora do roteamento por horas/dias se a revisão demorar → vendas roteadas pra OC/transferência sem necessidade. |

Residual aceito (documentar, não corrigir): janela física de segundos entre o picker tirar a peça da prateleira e gravar a mov — se os bipes do MESMO SKU intercalam esse intervalo, há ambiguidade inerente. Com F2 fechado, picks novos não são mais direcionados pra locs em contagem, encolhendo a exposição.

---

## Decisões (confirmar com Eryk antes de executar)

- **D1 — Retomada pós-30min:** se o operador só volta depois do recovery (30min), os bipes já foram descartados (P0-02) e a loc voltou pro pool — ele recomeça. Aceito? (Alternativa: aumentar TTL do recovery; não recomendo, segura loc de operador morto.)
- **D2 — F4 (lock per-loc):** liberar o lock externo da loc no `finalizarLoc` muda comportamento operacional (loc volta pro roteamento assim que contada, antes da aprovação). A matemática continua correta (modelo delta). Recomendo SIM, mas é mudança de comportamento.
- **D3 — F3:** preflight com erro acionável (recomendado) vs pular a divergência colidente e aplicar o resto. Recomendo preflight: mantém tudo-ou-nada, mas o supervisor recebe a lista exata (produto, loc, pedido dono da reserva) pra resolver.

---

## Fase 1 — Retomada pós-refresh (F1, P0)

### 1.1 RPC: fase de retomada + modo só-retomar
Migration nova (`YYYYMMDD_inventario_proxima_loc_retomada.sql`), `CREATE OR REPLACE wms_inventario_proxima_loc(p_sessao, p_user, p_somente_retomar boolean DEFAULT false)`:

- **FASE 0 (antes de tudo, após guards):** `SELECT` loc `em_contagem AND bloqueada_por = p_user` na sessão (mais recente por `bloqueada_em`). Se existir → retorna ela com `retomada: true`, payload normal (esperados em modo aberto) **+ `bipes`**: agregado `jsonb` das contagens deste operador nessa loc (`produto_id`, `sku`, `qty`) pra reidratar a UI.
- `p_somente_retomar = true` e sem loc ativa → retorna `{ok: true, sem_loc_ativa: true}` **sem claimar nada**.
- Demais fases inalteradas.
- ⚠ Operador pode ter 2 locs `em_contagem` (estado legado do próprio bug): retomar a mais recente; as outras o recovery resolve.

→ verifica: teste de integração — claim, chamar de novo → MESMA loc + `retomada: true`; `p_somente_retomar` sem loc ativa → não claima (pool intacto).

### 1.2 Service + rota
`pegarProximaLoc(sessaoId, usuarioId, opts?: { somenteRetomar?: boolean })` em `inventario.ts`; rota `proxima-loc` aceita body/query `retomar=1`. Tipos: `ProximaLocOutput` ganha `retomada?: boolean`, `sem_loc_ativa?: boolean`, `bipes?: Array<{produto_id, sku, qty}>`.

→ verifica: unit do shape + integração da rota.

### 1.3 Frontend contar
Em `contar/page.tsx`: ao montar com `meuOp` ativo (efeito pós-standby), dispara `proxima-loc?retomar=1`. Se voltou loc → `setLocAtual`, reidrata `contagens` com os `bipes` (qty já contada por SKU), `setEtapa("counting")`, toast "Retomando A-03-02 — contagens preservadas". Se `sem_loc_ativa` → standby normal. Botão "Pegar próxima" inalterado.

→ verifica: cenário manual — F5 no meio da contagem → volta pra MESMA loc com quantidades na tela; refresh em standby → não claima loc.

### 1.4 Copy do toast de re-entrada
"Voltou pra party — contagens preservadas" passa a ser verdade com 1.3. Revisar se a mensagem dupla (party + retomada) não confunde.

---

## Fase 2 — Fechar furos de lock (F2, P1)

Padrão único: mesma exclusão de `siso_localizacao_locks WHERE finalizado_em IS NULL` já usada em `roteamento.ts`/`sugestao-dinamica.ts`/`reconciliador-oc.ts`. Extrair helper `locsBloqueadasSet(sb)` em `lib/wms/localizacoes.ts` (ou novo `loc-locks.ts`) e usar nos 3 pontos novos + considerar migrar os 3 existentes (follow-up, não obrigatório).

### 2.1 `realocacao-resolver.ts`
`listarSaldoCandidato` (deps default) exclui locs travadas. Função pura `resolverRealocacao` não muda — teste unit injeta candidatos já filtrados.

→ verifica: unit — candidato travado não aparece; integração — cascade do parcial não cria R em loc de sessão ativa.

### 2.2 `buscarLocComMaiorSaldoNoGalpao` (`wms-mapping.ts`)
Filtrar locked nas duas branches (vendáveis e geral). Atenção aos callers — usado também fora do parcial; o filtro é seguro (loc travada não deve receber R nem pick novo).

→ verifica: unit/integration.

### 2.3 `sugerirLocalizacaoPutaway` (`putaway.ts`)
Excluir locked das candidatas. Se a única candidata (incl. `DEFAULT-PICKING`) está travada → retorna `null` (operador decide no tablet, comportamento já existente).

→ verifica: unit com lock ativo → pula pra próxima candidata / null.

### 2.4 Documentar decisão: pick de reserva PRÉ-EXISTENTE continua permitido
`wms_pick_item_atomico` NÃO ganha hard-block — bloquear pararia a separação (anti-objetivo). A reconciliação temporal absorve. Registrar em `docs/architecture-and-flows.md` + comentário no RPC ou no `pick-mov.ts`.

---

## Fase 3 — Aplicação × reservas vivas (F3, P1)

### 3.1 Preflight na RPC `wms_aplicar_sessao_inventario`
Antes do loop de movs: pra cada divergência de perda (`delta < 0`), checar `saldo - |delta| >= reservado` na tripla. Se alguma viola → `RAISE EXCEPTION` com payload estruturado (produto sku, loc código, saldo, reservado, qty perda) **antes de inserir qualquer mov**. Serviço mapeia pra 409 `aplicacao_colide_reserva` com a lista + os `origem_id` (pedidos) das R vivas da tripla.

→ verifica: integração — sessão com perda colidindo com R → 409 com lista; após liberar a R → aplica normal.

### 3.2 UI de divergências
Badge "⚠ colide com reserva" nas perdas cuja tripla tem `reservado > saldo - |delta|` (query no GET de divergências). Ação sugerida no tooltip: resolver o pedido dono da reserva ou rejeitar a divergência.

→ verifica: render condicional + estado limpo quando reserva some.

---

## Fase 4 — Higiene (F4 + P2s)

### 4.1 Dono explícito do lock + liberação per-loc
- Migration: `ALTER TABLE siso_localizacao_locks ADD COLUMN sessao_id uuid NULL REFERENCES siso_inventario_sessoes(id)`. `iniciarSessao` passa a gravar. Resolve de vez a limitação P2-INV-02 (liberação por proxy `iniciado_em >= iniciada_em` em `aprovarSessao`/cancelar/aplicar → trocar pra `sessao_id = X`).
- `finalizarLoc` libera o lock externo daquela loc (`sessao_id` + `localizacao_id`) — loc contada volta pro roteamento na hora. (Condicionado a D2.)

→ verifica: integração — finalizar loc → lock finalizado → roteamento volta a enxergar a loc; aprovar sessão não solta lock de OUTRA sessão.

### 4.2 `computarDivergencias`: órfãs antes do cálculo
Mover o bloco de limpeza de órfãs (hoje DEPOIS do upsert, `inventario.ts:1235`) pra ANTES do carregamento de contagens, chamando `descartarContagensDeLocsDevolvidas` nelas — bipes parciais de zumbi não viram divergência. Em modo `parcial` já não entram (filtro por status); o fix cobre o full/forçado.

→ verifica: unit/integração — loc em_contagem de operador finalizado com bipes parciais → bipes descartados, loc fora do cálculo, volta pro pool... **atenção:** sessão vai pra `revisao` no fim do computar — loc descartada nunca mais é contada nessa sessão. Comportamento correto: ela entra como NÃO visitada (sem divergência), igual a hoje, só que sem os bipes fantasma.

### 4.3 Documentação + erros-conhecidos
- `erros-conhecidos.yaml`: entrada do bug do refresh (id `wms-inventario-refresh-pula-loc`) + entrada F3 (aplicação travada por reserva).
- `docs/architecture-and-flows.md` / `docs/fluxos-siso.md`: seção "inventário com operação viva" — o que é garantido (temporal), o que é soft (locks), residual físico aceito.
- `docs/api-reference-complete.md`: param novo de `proxima-loc`.
- `CLAUDE.md`: nota na seção de RPCs se a assinatura de `wms_inventario_proxima_loc` mudar.

---

## Ordem de execução e dependências

```
Fase 1 (P0, independente)   → destrava o bug reportado
Fase 2 (P1, independente)
Fase 3 (P1, independente)
Fase 4.1 depende de D2; 4.2/4.3 independentes
```

Cada fase é um PR/commit isolado com seus testes. Staging only (`ehbxpbeijofxtsbezwxd`), migrations via arquivo + Management API (MCP geralmente off).
