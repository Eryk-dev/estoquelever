# WMS Fix-Final — design (3 fixes: A · B · C)

**Data:** 2026-05-27
**Branch base:** `develop`
**Ambiente:** **staging only** (`ehbxpbeijofxtsbezwxd`, org `100M`). **Zero touch** em prod (`wrbrbhuhsaaupqsimkqz`).
**Spec mãe da auditoria:** [`docs/superpowers/specs/2026-05-26-auditoria-wms-fixes-design.md`](2026-05-26-auditoria-wms-fixes-design.md)
**Planos consumidos:** P1–P6 (todos mergeados em `develop` em PRs #4–#8 + commits diretos do P4).

---

## 0. Por que este fix-final existe

Os 6 PRs originais (P1–P6) entregaram a maior parte dos 141 findings da auditoria 2026-05-26, mas a varredura pós-merge identificou **22 itens residuais** distribuídos em três naturezas distintas:

1. **Regressões / reverts / TODOs deixados no código** — fixes que voltaram atrás (`#2.15`) ou que ficaram marcados como "fix completo escalado pra P3/P6" no próprio código (TODOs em `validar-oc-item`, `localizacao`).
2. **Compromissos dos planos originais não cumpridos** — endpoints prometidos pela UI mas nunca criados (Banner D10 "Estornar agora", D2 "Liberar reserva"), riscos cross-plano explicitamente escalados pra P6 que nunca viraram migration (R5 `siso_notas_fiscais`), backfill de mitigação que nunca rodou em staging (R1).
3. **Out-of-scope deferidos pelos planos** — itens que P3/P5 marcaram explicitamente como "fica pra um próximo round" e que P6 não absorveu.

O fix-final **não inventa escopo novo**: cada item rastreia 1:1 um compromisso de um plano original (P1–P6) que não foi cumprido, um TODO deixado no código pelos próprios commits desses planos, ou uma decisão deferida documentada nas seções "Out-of-scope" dos planos.

**Princípios não-negociáveis (PR-1..PR-8 da spec mãe) continuam valendo.** Toda escrita de saldo passa por `wms_inserir_movimentacao`; toda ação destrutiva tem reverse simétrico; toda tabela operacional ao vivo entra na publication `supabase_realtime`; backend valida permissão; apuração por empresa = report sobre tags; custo médio é global; idempotência em ações destrutivas; exceções operacionais visíveis na home.

---

## 1. Mapa dos 22 itens (referência canônica `#M.S` da auditoria 05-26)

### Fix-A — Cobertura ledger (P0)

Risco prod direto. **Bloqueia Fix-B e Fix-C.**

| # | ID | Título | Origem |
|---|---|---|---|
| A1 | `#2.15` | Re-aplicar gating "dupla baixa OC em concluir-oc" sem quebrar NF em WMS mode | Revert `c349ead` (P2) |
| A2 | `#2.6` | `desfazer_encontrei` estorna mov S + limpa `mov_saida_id`/`quantidade_pega` | TODO em `validar-oc-item/route.ts:188` |
| A3 | `#2.7-followup` | `/separacao/localizacao` trata `reservado > 0` na loc origem (libera R + reemite no destino) | TODO em `localizacao/route.ts:116` |
| A4 | concern smoke 05-22 | `marcar-item` em fluxo transferência resolve loc via `separacao_galpao_id` (não `empresa_origem_id`) | `docs/superpowers/smoke-2026-05-21-cenarios-estoque.md:80` |
| A5 | `#1.9` (backend) | Endpoint `POST /api/wms/pedidos/[id]/estornar` (Banner D10 admin) | TODO em `pedidos/[id]/page.tsx:423` |
| A6 | `#1.x` (D2) | Endpoint `POST /api/wms/pedidos/[id]/liberar-reservas` (D2 override admin) | TODO em `pedidos/[id]/page.tsx:1014` + `checklist/page.tsx:528` |
| A7 | R5 | Migration `siso_notas_fiscais` (UUID NF + FK) + `siso_movimentacoes.nota_fiscal_id` UUID populado em devoluções | Decisão R5 `c523999` escalada pra P6, não cumprida |
| A8 | R1 | Executar `scripts/wms/backfill-compras-recebidas.ts` em staging + documentar resultado | Plano P2 §10.6 (não executado) |

### Fix-B — Out-of-scope + tasks P6 órfãs (P2)

Polish + completude funcional. **Não bloqueia operação.**

| # | ID | Título | Origem |
|---|---|---|---|
| B1 | P6 A.5 | Deletar endpoint órfão `transferir-galpao` (validar não existe + remover) | P6 Task A.5 sem commit rastreável |
| B2 | P6 B.3 | `vendas-disponibilidade` sem nomes hardcoded "CWB"/"SP" (usar `siso_galpoes`) | P6 Task B.3 sem commit rastreável |
| B3 | P6 E.26 | `cancelar` separação: limitar `movs_estornadas` JSONB (truncar > N entradas) | P6 Task E.26 sem commit rastreável |
| B4 | `#4.13` | `computarDivergencias` re-execução não duplica `lock cleanup` | Out-of-scope P3 §finally |
| B5 | `#6.9` | Loc tipo=`quarentena` sai da sugestão de `wms_inventario_sugerir` | Out-of-scope P3 §finally |
| B6 | `#2.17` | `desfazer-parcial` UI existente (botão ou mensagem que aponta caminho real) | Out-of-scope P5 (P6 não absorveu) |
| B7 | `#5.22` | `parcial-modal` ganha opção "encaminhar pra OC" | Out-of-scope P5 |
| B8 | `#8.13` | `/wms/replenishment` deixa de ser só readonly (ou marca explícito como consulta) | Out-of-scope P5/P6 |
| B9 | OoS P3 Task 43 | Coluna `devolucao_id text` em `siso_movimentacoes` pra lookup determinístico de desclassificar | P3 §3143-3149 |
| B10 | OoS P3 Task 35 | Desfazer guarda **parcial** com qty configurável | P3 §3143-3149 |
| B11 | OoS P3 Task 53 | Coluna `tracking_origem_ids text[]` em `siso_wms_pendencias_guarda` | P3 §3143-3149 |

### Fix-C — QA + cleanups (P3)

Higiene. **Roda só depois de Fix-A e Fix-B mergeados em `develop`.**

| # | ID | Título | Origem |
|---|---|---|---|
| C1 | P5 §7.2 | Validar layout responsivo (3 breakpoints: mobile/tablet/desktop) | Deferido `d8f2df8` |
| C2 | P5 §7.3 | Lighthouse pass em `/wms`, `/wms/separacao`, `/wms/pedidos` | Deferido `d8f2df8` |
| C3 | P5 §7.5 | Error handling smoke (toast em 4xx/5xx das rotas principais) | Deferido `d8f2df8` |
| C4 | P5 §5.16 | Smoke matrix UI fixes (P5 §5.1–5.14 in browser) | Deferido `a8dcebe` |
| C5 | P5 §3.4 | Realtime smoke E2E em browser (R criada/liberada invalida home) | Deferido `9ea2366` |
| C6 | CLAUDE.md "deprecated" | Dropar `siso_pedido_item_estoques` (com cleanup de consumidores legados) | CLAUDE.md §Deprecated |
| C7 | CLAUDE.md "deprecated" | Remover `getValidTokenByFilial` (`tiny-oauth.ts:216`) | `@deprecated` |
| C8 | CLAUDE.md "deprecated" | Remover helpers cargo em `compras-utils.ts:55` (usar `userCan`) | `@deprecated` |
| C9 | CLAUDE.md "deprecated" | Remover coluna `siso_pedidos.observacoes_old` (migration) | `@deprecated` |
| C10 | CLAUDE.md "deprecated" | Remover campo `localizacoes_excluir` em `realocacao-resolver.ts:42` (usar `localizacoes_tentadas`) | `@deprecated` |

---

## 2. Fix-A — Cobertura ledger (detalhado)

### A1 — Re-aplicar gating "dupla baixa OC" em `/concluir-oc`

**Problema:** commit `e020567` adicionou gating `WMS_AS_SOURCE` pra evitar dupla baixa em OC, mas `c349ead` reverteu porque quebrava emissão de NF. Janela de bug volta a estar aberta: em WMS mode, `concluir-oc` enfileira `lancar_estoque` legacy + dispara cutover do ledger → dupla baixa.

**Fix:** o gating original tinha duas responsabilidades misturadas (skip do enqueue legacy + cutover ledger). Separar:
- Mantém skip do enqueue legacy quando `WMS_AS_SOURCE=true` (já está em `e020567`).
- Cutover do ledger (criação dos movs S+L para OC) **só executa se NF emitida**; se NF ainda não chegou, transita `aguardando_nf` e deixa `nf-webhook-handler` disparar o cutover.
- Adiciona check `pedido.status_separacao === 'aguardando_nf' && pedido.nota_fiscal_id !== null` antes de qualquer mov.

**Aceite:**
- Cenário novo `18_concluir_oc_aguarda_nf.ts`: separação OC concluída antes da NF → status=`aguardando_nf`, zero movs S no ledger. NF chega → cutover dispara → I1..I7 verdes.
- Cenário novo `19_concluir_oc_nf_ja_emitida.ts`: NF já chegou antes de `concluir-oc` → cutover imediato, zero enqueue legacy, I1..I7 verdes.

### A2 — `desfazer_encontrei` estorna mov S

**Problema:** `validar-oc-item/route.ts:188` tem TODO documentado: `desfazer_encontrei` não estorna a mov S nem limpa `mov_saida_id`/`quantidade_pega`. Saldo fica decrementado até `cancelar` ou `desfazer-parcial`.

**Fix:**
- `validar-oc-item` aceita action `desfazer_encontrei` que:
  1. Lê `mov_saida_id` do item.
  2. Chama `wms_inserir_movimentacao(tipo='E', origem_tipo='estorno', estorno_de=mov_saida_id, ...)`.
  3. Zera `mov_saida_id`, `quantidade_pega`, `separacao_parcial`, `parcial_motivo` no item.
- Registra evento `desfazer_encontrei_oc` em `siso_pedido_historico`.
- Remove o TODO do código.

**Aceite:** cenário `20_oc_encontrei_e_desfazer.ts` valida saldo volta ao estado inicial, I1..I7 verdes.

### A3 — `/separacao/localizacao` com `reservado > 0`

**Problema:** `localizacao/route.ts:116` tem TODO: src com `reservado > 0` falha a S (validarCoerencia). Catch absorve+loga e o operador depende de mover só locs sem R ativa.

**Fix:** quando endpoint detecta `reservado > 0` na loc origem:
1. Libera as Rs da loc origem (chama `estornarReservaIndividual` por R).
2. Move o saldo (par S+E).
3. Re-emite as Rs equivalentes no destino (`wms_reservar_atomico`).
4. Tudo dentro de uma transação (SAVEPOINT por sub-step pra rollback granular se algo falhar).

**Aceite:** cenário `21_separacao_localizacao_com_reservas.ts` (R ativa na loc origem, move, valida que R aparece na loc destino com mesmo `ttl_horas`).

### A4 — `marcar-item` em transferência usa `separacao_galpao_id`

**Problema:** smoke 05-22 documenta concern: `marcar-item` em fluxo transferência resolve loc via `pedido.empresa_origem_id` em vez de `pedido.separacao_galpao_id`. Cenários 02/03 patcham `siso_pedido_item_estoques.localizacao` via SQL pra passar. Em prod, transferência aprovada pra outro galpão pega a loc da empresa origem (errada).

**Fix:** `marcar-item` (e callers como `bipar-checklist`, `validar-oc-item/encontrei`) resolve loc pelo **galpão real onde a separação acontece** (`pedido.separacao_galpao_id` em transferência; fallback `empresa_origem_id` em própria). Helper centralizado `resolveSeparacaoGalpao(pedido)` em `src/lib/separacao/wms-mapping.ts`.

**Aceite:**
- Refatorar cenários 02 e 03 pra remover os patches SQL workaround.
- Adicionar cenário `22_transferencia_marcar_item_galpao_destino.ts` explícito.

### A5 — Endpoint `POST /api/wms/pedidos/[id]/estornar`

**Problema:** Banner D10 (admin) em `pedidos/[id]/page.tsx:423` mostra `toast.error("não implementado — abrir ticket")`.

**Fix:** novo endpoint que:
1. Requer perm `pedidos.estornar` (criar nova perm + adicionar role `admin`).
2. Valida estado: pedido em `executando` ou `concluido` com movs S em ledger.
3. Lê `siso_movimentacoes` do pedido (`origem_id=pedido.id` ou via `siso_pedido_item_mov_links`).
4. Estorna cada mov via `wms_inserir_movimentacao(tipo='E', estorno_de=mov_id, ...)`.
5. Libera todas as Rs ativas do pedido.
6. Transita pedido pra `cancelado_manual` (novo status; ou reaproveita `cancelado` + tag `manual`).
7. Registra evento `estorno_manual_admin` com `usuario_id` + `motivo` (obrigatório no body).
8. Frontend troca `toast.error` por `mutation.mutate({ motivo })`.

**Aceite:** cenário `23_estorno_manual_admin.ts` (pedido concluído → estornar → saldo volta, Rs liberadas, status `cancelado`).

### A6 — Endpoint `POST /api/wms/pedidos/[id]/liberar-reservas`

**Problema:** D2 override em `pedidos/[id]/page.tsx:1014` + TODO em `checklist/page.tsx:528` ("criar reserva atômica em wms_inserir_movimentacao com origem_tipo=reserva_pedido_encontrei"). UI sem ação.

**Fix:** novo endpoint que:
1. Requer perm `pedidos.liberar_reservas` (nova perm; role `admin`).
2. Lê todas as Rs ativas do pedido (`siso_movimentacoes WHERE tipo='R' AND origem_id=pedido.id AND NOT EXISTS (estorno)`).
3. Para cada R, chama `estornarReservaIndividual(mov_id)`.
4. Registra evento `liberar_reservas_admin` com `usuario_id` + `motivo`.
5. Frontend dispara mutation; quadro home invalida via realtime (Fix-A herda P1).

**Aceite:** cenário `24_liberar_reservas_admin.ts` (pedido com 5 Rs → liberar → 5 Rs estornadas, disponivel ↑, I1..I7 verdes).

### A7 — Migration `siso_notas_fiscais` (R5)

**Problema:** R5 escalada pra P6 mas migration `20260527_siso_notas_fiscais.sql` nunca foi criada. Devoluções continuam sem `nota_fiscal_id` real no ledger; lookup hoje vai via `chave_acesso_nf` (workaround E.35).

**Fix:**
1. Migration `20260527_siso_notas_fiscais.sql`:
   - Cria `siso_notas_fiscais (id uuid PK default gen_random_uuid(), tiny_nota_fiscal_id bigint, chave_acesso text UNIQUE, numero text, serie text, empresa_id uuid FK, tipo text CHECK in ('entrada','saida'), criada_em timestamptz default now(), raw_tiny jsonb)`.
   - `siso_movimentacoes.nota_fiscal_id` (já existe como UUID nullable) ganha FK.
2. Webhook NF (entrada e saída) faz upsert em `siso_notas_fiscais` antes de criar movs.
3. `wms_inserir_movimentacao` valida `nota_fiscal_id` existe quando `origem_tipo IN ('nf_compra','nf_venda','devolucao_*')`.
4. Backfill leve: SQL one-shot que cria `siso_notas_fiscais` retroativo a partir de `siso_pedido_historico`/`siso_movimentacoes.origem_detalhes`.

**Aceite:** smoke staging — toda mov criada nos próximos 24h tem `nota_fiscal_id` populado (não NULL) quando `origem_tipo` exige NF. Query auditável.

### A8 — Executar backfill R1 em staging

**Problema:** `scripts/wms/backfill-compras-recebidas.ts` criado em `b12a4ef` (P2 §10.6 mitigation), mas execução em staging não foi documentada. OCs recebidas antes do P2 não têm mov correspondente no ledger → reconciliação dispara divergências falsas.

**Fix:**
1. Dry-run em staging (`--dry-run`): contar quantas OCs entram, listar empresas/galpões afetados, estimar movs a criar.
2. Run real com log estruturado em `docs/superpowers/backfill-r1-2026-05-27-staging.md`.
3. Rodar `wms_detectar_divergencias_estoque()` antes e depois — esperado: divergências reduzem ou ficam estáveis.

**Aceite:** doc do backfill criado + `wms_detectar_divergencias_estoque()` retorna ≤ baseline pré-backfill.

---

## 3. Fix-B — Out-of-scope + tasks P6 órfãs (detalhado)

### B1 — Deletar `transferir-galpao` órfão

Validar: existe `src/app/api/wms/transferir-galpao/route.ts`? Existe consumidor (`grep`)? Se órfão (P6 §A.5 concluiu que sim), deletar arquivo + remover entrada em `docs/api-reference-complete.md`. Se ainda tem consumidor, abrir issue.

### B2 — `vendas-disponibilidade` sem hardcoded

`src/lib/wms/vendas-disponibilidade.ts` (e/ou `src/app/api/wms/vendas/disponibilidade/route.ts`) faz `if (galpao.nome === 'CWB')` ou similar. Trocar por uso de `siso_galpoes` (consulta) ou `siso_empresa_galpoes_preferenciais` (geo-priority). Já existe lógica análoga em `roteamento.ts` — reusar.

### B3 — `cancelar` separação: limitar `movs_estornadas` JSONB

Auditar `src/app/api/wms/separacao/cancelar/route.ts` — atualmente grava array completo de `movs_estornadas` em JSONB. Em pedido com >100 movs (raro mas possível em OC misto), payload cresce demais. **Fix:** truncar pra N=50 mais recentes + adicionar contador `movs_estornadas_total`; movs completas ficam queryable via `siso_movimentacoes WHERE origem_id=pedido.id AND tipo='E'`.

### B4 — `computarDivergencias` re-execução

`src/lib/wms/inventario.ts` — quando supervisor clica "encerrar parcial" duas vezes, `cleanup` de locks roda duas vezes (idempotente, mas loga warning falso). **Fix:** check `sessao.status='revisao'` antes de cleanup; se já em revisao, skip cleanup + retorna no-op.

### B5 — Loc `quarentena` fora da sugestão de inventário

`wms_inventario_sugerir(p_galpao, p_tamanho)` (RPC) — hoje retorna locs de todos os tipos. Filtrar `WHERE l.tipo != 'quarentena'`. Migration adiciona `AND l.tipo != 'quarentena'` à query.

### B6 — `desfazer-parcial` aponta UI real

Mensagem em `marcar-item/route.ts` (P6 commit `b5d1fe8`) ainda aponta UI inexistente em casos específicos. Auditar todas as mensagens que mencionam "/desfazer-parcial" — devem apontar `parcial-modal` ou similar.

### B7 — `parcial-modal` opção OC

`src/components/wms/separacao/parcial-modal.tsx` — adicionar radio "encaminhar pra OC" como 3ª opção, chamando endpoint `encaminhar` com `decisao='oc'`.

### B8 — `/wms/replenishment` deixa de ser só readonly

Hoje, página só lista sugestões. P6 commit `28d0502` mudou subtitle ("primariamente consulta") mas não adicionou ação. **Fix:** botão "Criar movimentação" por linha (chama endpoint `/api/wms/replenishment` existente em modo POST).

### B9 — Coluna `devolucao_id text` em `siso_movimentacoes`

Hoje, desclassificar devolução faz lookup heurístico via `chave_acesso_nf` + `origem_tipo`. **Fix:** migration adiciona `devolucao_id uuid FK siso_devolucoes_pendentes(id)` em movs B/C/D; endpoint `desclassificar` usa essa coluna pro lookup determinístico (P3 Task 43 deferida).

### B10 — Desfazer guarda parcial com qty configurável

`POST /api/wms/guarda/[id]/desfazer` hoje desfaz a pendência inteira (P3 MVP §Task 35). **Fix:** aceitar body `{ qty }` opcional; se `qty < qty_guardada`, faz estorno parcial (mov par S+E na loc destino → RECEBIMENTO).

### B11 — Coluna `tracking_origem_ids text[]`

`siso_wms_pendencias_guarda` hoje guarda `tracking_origem_id` único. **Fix:** migration adiciona `tracking_origem_ids text[]` (P3 Task 53); webhook receber popula array; UI exibe lista.

---

## 4. Fix-C — QA + cleanups (detalhado)

### C1–C5 — QA P5 deferido

Executar manualmente em staging:
- **C1 (responsivo):** abrir 6 telas-chave (`/wms`, `/wms/separacao`, `/wms/pedidos`, `/wms/pedidos/[id]`, `/wms/inventario/[id]`, `/wms/guarda/rota`) em mobile (375px), tablet (768px), desktop (1440px). Screenshots em `docs/superpowers/qa-c1-responsivo-2026-05-27.md`. Bugs viram tasks em Fix-D (fora do escopo deste plano se trivial; se grave, adiar Fix-C).
- **C2 (lighthouse):** rodar `lighthouse https://estoquelever.vercel.app/wms` 3x e tirar mediana. Target: Performance ≥ 60, Accessibility ≥ 90, Best Practices ≥ 90. Resultado em `docs/superpowers/qa-c2-lighthouse-2026-05-27.md`.
- **C3 (error handling):** matriz 5 rotas × 3 erros (401, 403, 500) — confirmar toast aparece, página não quebra.
- **C4 (smoke matrix UI):** rodar 12 fluxos do P5 §5.16 manualmente. Checklist em `docs/superpowers/qa-c4-smoke-2026-05-27.md`.
- **C5 (realtime browser):** abrir 2 abas, criar pedido na aba 1, validar aba 2 atualiza < 3s.

### C6 — Dropar `siso_pedido_item_estoques`

Pré-requisitos: Fix-A merged (zero consumidores novos). Sequência:
1. `grep -r "siso_pedido_item_estoques" src/` — confirmar lista de consumidores.
2. Migrar cada consumidor pra ler de `siso_estoque` + `siso_movimentacoes` (ledger).
3. Migration `20260530_drop_siso_pedido_item_estoques.sql` (renomeia pra `_archived` primeiro, depois drop em outro PR após 7 dias).

### C7–C10 — `@deprecated`

- **C7:** `grep "getValidTokenByFilial" src/` — substituir caller a caller por `getValidTokenByEmpresa`. Deletar função.
- **C8:** helpers `cargo` em `compras-utils.ts:55` — substituir por `userCan(session, "perm.x")`. Deletar.
- **C9:** migration `ALTER TABLE siso_pedidos DROP COLUMN observacoes_old`. Antes, confirmar `grep "observacoes_old"` retorna zero.
- **C10:** campo `localizacoes_excluir` em `realocacao-resolver.ts:42` — confirmar callers já usam `localizacoes_tentadas`, deletar campo compat.

---

## 5. Critérios de pronto globais

- [ ] Fix-A, Fix-B, Fix-C cada um em PR separado (3 PRs) contra `develop`.
- [ ] Cada PR cria/atualiza commits em `erros-conhecidos.yaml` pros bugs fixados.
- [ ] Cada PR atualiza `docs/api-reference-complete.md` (endpoints novos) + `docs/database-schema.md` (migrations) + `CLAUDE.md` (seção "Recently Fixed" + remoção dos itens de "Deprecated / To Remove").
- [ ] Suite `npm run scenarios` continua 17/17 verde. Cenários novos (18–24) adicionados em Fix-A passam.
- [ ] `wms_detectar_divergencias_estoque()` retorna ≤ baseline pré-fix-final (medido antes de Fix-A começar, anotado em spec).
- [ ] Smoke staging: criar 1 pedido, separar, embalar, expedir — sem regressão visível.
- [ ] Migrations aplicadas via `mcp__supabase__apply_migration` no project `ehbxpbeijofxtsbezwxd` (staging). **Nada** aplicado em `wrbrbhuhsaaupqsimkqz` (prod).

---

## 6. Riscos cross-fix

- **RF1** — Fix-A A1 (gating concluir-oc) pode introduzir nova janela onde NF emitida e cutover não dispara. **Mitigação:** cenários 18+19 cobrem ambos os ramos (NF antes/depois). Smoke manual antes do merge.
- **RF2** — Fix-A A7 (migration `siso_notas_fiscais`) tem backfill retroativo que pode falhar em dados históricos inconsistentes. **Mitigação:** backfill é best-effort com log de skips; movs antigas ficam com `nota_fiscal_id=NULL` (não exige FK retro-ativa).
- **RF3** — Fix-C C6 (drop `siso_pedido_item_estoques`) pode quebrar consumidor legacy ainda não migrado. **Mitigação:** rename pra `_archived` antes do drop final; janela de 7 dias com tabela inacessível mas restaurável.
- **RF4** — QA C1-C5 podem revelar bugs novos. **Mitigação:** classificar antes (P0/P1/P2); P0 vira hotfix imediato, P1/P2 viram backlog separado (não bloqueia Fix-C).

---

## 7. Ordem de execução

```
Fix-A (P0, ~8 itens)
  ├── Migrations: siso_notas_fiscais + perms novas (estornar/liberar_reservas)
  ├── Endpoints: pedidos/[id]/estornar + liberar-reservas
  ├── Code fixes: A1..A4 + UI Banner D10/D2
  └── Backfill R1 + smoke staging
  → Merge develop → habilita Fix-B/C

Fix-B (P2, ~11 itens) — paralelo a Fix-C planning
  ├── Cleanups: B1/B2/B3
  ├── Polish: B4-B8 (UI + RPC tweaks)
  └── Migrations leves: B9/B11 (colunas opcionais)
  → Merge develop

Fix-C (P3, ~10 itens) — após A+B em develop estáveis
  ├── QA P5: C1-C5 (manuais, documentados em md)
  ├── Migrate consumidores: C6 (rename siso_pedido_item_estoques)
  └── Limpa @deprecated: C7-C10
  → Merge develop
```

---

## 8. Apêndice — mapeamento finding → plano original

| Item | Origem (plano) | Status original |
|---|---|---|
| A1 (`#2.15`) | P2 §6.15 | Aplicado em `e020567`, revertido em `c349ead` |
| A2 (`#2.6`) | P2 §6.6 follow-up | Apenas `docs(761a70f)` com TODO; código não tocado |
| A3 (`#2.7-fu`) | P2 §6.7 follow-up | Fix base ok, TODO `reservado>0` aberto |
| A4 (concern) | smoke `2026-05-21` L80 | Não migrado |
| A5 (`#1.9`) | P3 alvo backend, P5 alvo UI | Nem backend nem UI implementados |
| A6 (D2) | P3 alvo backend | UI menciona, endpoint não criado |
| A7 (R5) | P2 §11 risk → P6 escalation | Decisão UUID `c523999`, migration nunca criada |
| A8 (R1) | P2 §10.6 manual | Script existe (`b12a4ef`), execução não doc |
| B1 (A.5) | P6 setup A.5 | Sem commit rastreável |
| B2 (B.3) | P6 §B.3 | Sem commit rastreável |
| B3 (E.26) | P6 §E.26 | Sem commit rastreável |
| B4 (`#4.13`) | P3 §finally out-of-scope | Listado pra futuro |
| B5 (`#6.9`) | P3 §finally out-of-scope | Listado pra futuro |
| B6 (`#2.17`) | P5 out-of-scope | "P6 não absorveu" |
| B7 (`#5.22`) | P5 out-of-scope | "P6 polish" |
| B8 (`#8.13`) | P5/P6 flexível | Subtitle mudou, ação não criada |
| B9 (OoS P3 T43) | P3 §3143-3149 | Listado pra futuro |
| B10 (OoS P3 T35) | P3 §3143-3149 | MVP limitation |
| B11 (OoS P3 T53) | P3 §3143-3149 | Listado pra futuro |
| C1-C5 | P5 §7.2/7.3/7.5 + §5.16 + §3.4 | `d8f2df8`, `a8dcebe`, `9ea2366` (verify commits vazios) |
| C6 | CLAUDE.md "Deprecated / To Remove" | Flagged, não executado |
| C7-C10 | `@deprecated` no código | Flagged, não removido |

---

**Próximo passo:** invocar `superpowers:writing-plans` pra criar `2026-05-27-wms-fix-final-A.md`, `2026-05-27-wms-fix-final-B.md`, `2026-05-27-wms-fix-final-C.md`.
