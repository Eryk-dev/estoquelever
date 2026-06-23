# Spec — Auto-aprovação (exceto transferência) + Guarda dinâmica

- **Data:** 2026-06-08
- **Status:** Design aprovado (aguardando revisão do spec)
- **Ambiente:** staging (`develop` → `ehbxpbeijofxtsbezwxd`)
- **Origem:** pedido do dono do produto (Eryk) — duas features independentes, mesmo spec porque tocam o mesmo eixo (pedido → separação).

---

## 1. Problema

Hoje a aba `/wms/pedidos` é um filtro pra **tudo** (própria, transferência, OC). Só **própria** auto-aprova; transferência e OC esperam aprovação manual no painel. Isso gera fila humana desnecessária: OC e (na intenção do dono) tudo que tem como resolver deveria fluir direto pra separação. O painel de pedidos deveria sobrar **só pra transferência** — a única decisão que o dono quer revisar à mão.

Em paralelo, a **guarda** (put-away) mostra uma quantidade **estática**: ao receber 40 un, a tarefa diz "guardar 40" pra sempre, mesmo que 30 un já tenham sido separadas direto do recebimento. O operador chega na loc e só tem 10 — a guarda "mente". A quantidade a guardar precisa refletir o **saldo físico real no recebimento, em tempo real**.

---

## 2. Objetivos / Não-objetivos

### Objetivos
- **F1:** Todo pedido que não é transferência auto-aprova e cai na separação. `/wms/pedidos` fica só com transferência.
- **F1-OC:** Pedidos OC caem na **zona de verificação** dentro do checklist de separação (bucket amber "Itens OC"), onde o operador dá double-check físico com "Encontrei"/"Esgotado". Reusa o que já existe; adiciona um botão "Solicitar contagem da localização".
- **F2:** A quantidade "a guardar" passa a ser dinâmica (saldo real disponível no recebimento), auto-encerra quando zera, e trava ao iniciar a guarda.

### Não-objetivos
- Não migrar a coluna `qty_pendente` (GENERATED) de schema — calcular ao vivo.
- Não criar status novo nem RPC nova pro fluxo OC (já existe `validacao_oc` + `validar-oc-item`).
- Não mexer no fluxo de transferência (continua manual, igual hoje).
- Não tocar em prod.

---

## 3. Decisões (log)

| # | Decisão | Escolha do dono |
|---|---|---|
| D1 | OC (split E sem-cobertura) | **Toda OC auto-aprova e cai na separação** pra double-check físico. |
| D2 | OC sem-cobertura (peça não existe em lugar nenhum) | Cai na separação como OC na zona amber; operador confirma "Encontrei"/"Esgotado". |
| D3 | `/wms/pedidos` | **Só transferência.** Realocação (`pendente_realocacao`) sai pra outra tela. |
| D4 | Transferência | **Sempre manual** (única exceção). |
| D5 | Zona de verificação OC | **Dentro do checklist** (bucket amber "Itens OC"), não uma seção separada na fila. Pedidos OC ficam na fila normal de "Pra separar", mesclados. |
| D6 | "Encontrei" | **Dá baixa na hora** (comportamento atual): digita qty física + bipa loc → registra contagem (corrige saldo) → separado. |
| D7 | "Esgotado" | Mantém o nome "Esgotado" (não renomear pra "Não tem"). Item → compra + OC. |
| D8 | Misto (achou X, não tem Y) | Pedido inteiro vai pra aba **"Compras"** da separação; X fica separado esperando Y. |
| D9 | NOVO botão "Solicitar contagem da localização" | Operador pega a qty do pedido na hora (pedido → separado) **e** cria tarefa de inventário pra contar a loc depois. Pedido **não espera**. |
| D10 | "A guardar" (guarda dinâmica) | `min(qty não guardada, saldo DISPONÍVEL real no recebimento)` — mostra o real, não o inicial. |
| D11 | Livre vs reservado na guarda | Mostra livres pro local designado + reservadas pro picking (separa as duas). |
| D12 | Pendência de guarda quando saldo real → 0 | **Auto-encerra** e some da fila (sem tarefa fantasma). |
| D13 | Iniciar guarda | **Trava/reserva** a qty no recebimento (picking concorrente não rouba). |

---

## 4. Feature 1 — Auto-aprovar tudo exceto transferência

### 4.1 Como funciona hoje

- `webhook-processor-wms.ts:471` — `const isAuto = sugestao === "propria"`. Só própria enfileira job:
  - `webhook-processor-wms.ts:651` — `INSERT siso_fila_execucao { tipo:"lancar_estoque", decisao:"propria" }` + `kickWorker()`.
- Transferência e OC: `status="pendente"`, **nenhum job** → esperam aprovação manual em `/wms/pedidos`.
- Worker (`execution-worker.ts:306-324`): job `lancar_estoque` com `decisao:"oc"` → `executarMarcadoresOnly` (`execution-worker.ts:607`):
  - `resolveCompraItemIds` re-checa estoque **vivo**.
  - `compraDemandas.length === 0` (estoque cobre) → solta pro fluxo próprio (`decisao_final="propria"`, `aguardando_nf`, enfileira `lancar_estoque` próprio). `execution-worker.ts:657-713`.
  - `compraDemandas.length > 0` (falta de verdade) → `status_separacao="validacao_oc"` + itens `compra_status="oc_pendente"`. `execution-worker.ts:718-733`.
- **Elo que falta:** ninguém enfileira hoje um job `lancar_estoque` com `decisao:"oc"`. O webhook só enfileira `propria`; o `aprovar` route de OC (`aprovar/route.ts:368-383`) faz `UPDATE` direto com `status_separacao=null` e **não enfileira**. Por isso o caminho `validacao_oc` está, na prática, dormente pro fluxo OC normal.

### 4.2 Comportamento-alvo

| Decisão do roteador | Hoje | Alvo |
|---|---|---|
| **própria** | auto → `aguardando_nf` → separação | igual |
| **OC** (split ou sem-cobertura) | `pendente`, espera painel | **auto → job `decisao:"oc"` → `validacao_oc`** (ou própria se o worker achar estoque) |
| **transferência** | `pendente`, espera painel | igual — único item em `/wms/pedidos` |

### 4.3 Mudanças

**Backend (cirúrgico):**
1. `webhook-processor-wms.ts:471` — `isAuto` passa a cobrir própria **e** OC: `const isAuto = sugestao !== "transferencia"`.
2. `webhook-processor-wms.ts:644-665` — no ramo `isAuto`, enfileirar o job com a `decisao` correta:
   - própria → `decisao:"propria"` (igual hoje).
   - OC → `decisao:"oc"` (novo) → cai em `executarMarcadoresOnly` → `validacao_oc`/próprio.
   - **Não criar reserva pra OC** (não há saldo — esperado; o worker re-checa e o ramo próprio cria reserva quando couber).
3. Manter `aprovar/route.ts` como está (o ramo OC vira efetivamente código morto pro fluxo normal — **mencionar, não deletar** nesta entrega).

**Frontend:**
4. `/wms/pedidos` (`src/app/wms/pedidos/page.tsx:203-215` + `GET /api/wms/pedidos`): aba "Pendente" filtra só `sugestao="transferencia"`. `pendente_realocacao` **sai** desta aba (vai pra tela de realocação existente).
5. Home `quadro-tarefas.tsx:101-112` + `dashboard-tarefas.ts:762-776`: contador "Aprovação" conta só transferência.

### 4.4 Critérios verificáveis (F1)
- [ ] Webhook de pedido OC (sem-cobertura) → pedido entra `validacao_oc` com itens `oc_pendente`, **sem** passar por `/wms/pedidos`. (cenário E2E)
- [ ] Webhook de pedido OC-split cujo estoque na verdade cobre → worker solta pro fluxo próprio (`decisao_final="propria"`), com reserva criada.
- [ ] Webhook de transferência → continua `pendente`, aparece em `/wms/pedidos`.
- [ ] `/wms/pedidos` não lista mais própria/OC; só transferência. `pendente_realocacao` não aparece lá.
- [ ] Contador "Aprovação" da home = nº de transferências pendentes.

---

## 5. Verificação OC na separação (reaproveitar + 1 botão novo)

### 5.1 O que JÁ existe (não rebuildar)
- Status `siso_pedidos.status_separacao="validacao_oc"` (migration `20260522_add_validacao_oc_status.sql`).
- Item `siso_pedido_itens.compra_status="oc_pendente"`.
- Checklist com bucket amber: `checklist/page.tsx consolidar()` separa `itensNormais` vs `itensOC`. Display merge da tab: `page.tsx:118` (validacao_oc aparece em "Pra separar").
- `iniciar/route.ts:104-150` aceita `validacao_oc`. `cancelar/route.ts:299` reverte pra `validacao_oc`.
- Modal "Encontrei": `checklist/page.tsx:1886 OcEncontreiModal` — input "QUANTAS UNIDADES TEM NESSA PRATELEIRA?" + bipa loc.
- `POST /api/wms/separacao/validar-oc-item` — ações `encontrei` | `esgotado` | `desfazer_encontrei`:
  - `encontrei` → `registrarContagemInline` (mov E `inventario_ganho`) + `pickMovPicking` (mov S) → item separado.
  - `esgotado` → `compra_status="aguardando_compra"` + `linkItemToOC`.
- Transições de saída (`validar-oc-item/route.ts:568-649`): todos achados → `aguardando_separacao`; 100% esgotado → `aguardando_compra`.
- Reconciliação automática (estoque chega no meio): `reconciliador-oc.ts` + `varredura-validacao-oc.ts` (`flag_saldo_apareceu`).

### 5.2 Mudanças
1. **Polimento visual** do bucket "Itens OC" no checklist pra ficar claramente amber (tokens `--wms-c-warn-border` já existem). Confirmar se já está aplicado; lapidar se não.
2. **NOVO botão "Solicitar contagem da localização"** no `OcEncontreiModal` (D9), como alternativa a digitar a qty:
   - Operador bipa a loc e o sistema **separa a qty que o pedido pede** na hora (pedido → separado), via o mesmo caminho `encontrei` (mov E do achado + mov S do pick) — mas registrando só a qty do pedido, não a contagem total.
   - **Cria uma tarefa de inventário** pra contar a loc depois (plugar em `siso_inventario_*` / `wms_inventario_sugerir`). Pedido **não espera**.
   - Endpoint: estender `validar-oc-item` com uma sub-ação (ex: `acao:"encontrei"` + `solicitar_contagem:true`) ou nova ação. Decidir no plano de implementação.
3. **Misto → Compras (D8):** hoje misto não auto-transiciona (`concluir/route.ts` resolve). Ajustar pra que, quando a verificação terminar com ≥1 item "esgotado", o pedido vá pra `aguardando_compra` (aba "Compras" da separação) automaticamente; itens achados ficam separados esperando o resto chegar (reconciliador religa).

### 5.3 Critérios verificáveis (OC)
- [ ] Pedido OC abre no checklist com itens no bucket amber "Itens OC".
- [ ] "Encontrei" + qty física + loc → item separado, saldo do sistema corrigido (mov E), pedido com tudo achado → `aguardando_separacao`/separado.
- [ ] "Solicitar contagem" → pedido separado na hora **e** existe uma tarefa de inventário pendente pra aquela loc.
- [ ] "Esgotado" em todos os itens → pedido `aguardando_compra` + OC vinculada.
- [ ] Misto (1 achado + 1 esgotado) → pedido vai pra aba "Compras"; item achado consta como separado.

---

## 6. Feature 2 — Guarda dinâmica

### 6.1 Como funciona hoje
- `siso_wms_pendencias_guarda.qty_pendente` é **GENERATED** `(qty_inicial - qty_guardada)` (migration `20260514_wms_guarda_pendencias.sql:56`). Estático — não reflete saídas do recebimento.
- `wms_confirmar_guarda_atomico` (`20260527_p3_rpc_wms_confirmar_guarda_atomico.sql:48`) valida `p_qty > qty_pendente` (coluna estática); **não** compara com `siso_estoque.saldo` no recebimento; **não** dá `FOR UPDATE` no estoque do recebimento → race com picking.
- Roteamento (`roteamento.ts:262-267`) **não exclui** `tipo="recebimento"` → picking pode sair direto do recebimento antes da guarda, decrementando `siso_estoque.saldo` sem tocar `qty_pendente`.

### 6.2 Comportamento-alvo
- **"A guardar" ao vivo** = `min(qty ainda não guardada, saldo DISPONÍVEL real no recebimento da loc da pendência)`.
  - `disponível = saldo − reservado`. Cenário das reservas: 10 físicas, 3 reservadas → mostra **7 livres** pro local designado; as **3 reservadas** vão pro picking pro pedido pegar (D11).
  - Cenário do dono: recebeu 40, separaram 30 direto → mostra **10**, não 40.
- **Auto-encerra (D12):** saldo real → 0 ⟹ pendência fecha (status `guardada`/`cancelada` com 0 a guardar) e some da fila.
- **Trava ao iniciar (D13):** "Iniciar guarda" reserva/bloqueia a qty no recebimento (lock por localização) → picking concorrente não rouba. Dinâmico **até** iniciar; depois, a qty está comprometida.

### 6.3 Mudanças
1. **Cálculo ao vivo do "a guardar"** na leitura da pendência (`guarda.ts` / rota `GET /api/wms/guarda/**`): cruzar `qty_inicial - qty_guardada` com `siso_estoque` (saldo/reservado) na tripla `(produto, galpão, loc_origem da pendência)`. Não migrar a coluna GENERATED — calcular no service/rota e expor como `qty_a_guardar` derivado.
2. **Auto-encerrar pendência** quando o saldo real disponível chega a 0 (gatilho na entrada de saída do recebimento — provavelmente via `reconciliador`/ledger fire-and-forget, ou na leitura que detecta 0 e fecha). Decidir mecanismo exato no plano.
3. **Lock ao iniciar:** novo passo/estado "iniciar guarda" que cria um lock (`siso_localizacao_locks`) ou reserva sobre a qty no recebimento.
4. **`wms_confirmar_guarda_atomico`:** validar contra **saldo real disponível** no recebimento + `SELECT ... FOR UPDATE` na linha de `siso_estoque(recebimento)` na mesma transação (fecha a race com picking).
5. **Verificar** (o dono acha que já existe) o split "livres → local designado / reservadas → picking" no fluxo de guarda; lapidar o que faltar. Pode encostar em `wms_replenishment_intra_galpao` (par S+E).

### 6.4 Critérios verificáveis (F2)
- [ ] Recebe 40 → 30 separados direto do recebimento → tarefa de guarda mostra **10 a guardar** (não 40).
- [ ] 40 separados (tudo) → pendência **some** da fila (auto-encerra).
- [ ] 10 físicas com 3 reservadas → guarda mostra 7 livres (local designado) + 3 pro picking.
- [ ] "Iniciar guarda" de 10 → um pedido concorrente do mesmo produto **não** consegue separar essas 10 do recebimento.
- [ ] `wms_confirmar_guarda_atomico` com saldo real < qty pedida → falha cedo (validação contra saldo real), sem deixar a race do replenishment estourar.

---

## 7. Arquivos-âncora

**F1:**
- `src/lib/webhook-processor-wms.ts:471` (flag `isAuto`), `:644-665` (enfileiramento).
- `src/lib/execution-worker.ts:306-324` (dispatch), `:607-744` (`executarMarcadoresOnly`).
- `src/app/wms/pedidos/page.tsx:203-215` (filtro aba), `src/app/api/wms/pedidos/route.ts`.
- `src/components/wms/home/quadro-tarefas.tsx:101-112`, `src/lib/wms/dashboard-tarefas.ts:762-776`.

**OC:**
- `src/app/wms/separacao/checklist/page.tsx` (`consolidar`, `OcEncontreiModal:1886`).
- `src/app/api/wms/separacao/validar-oc-item/route.ts`, `iniciar/route.ts:104`, `cancelar/route.ts:299`.
- `src/lib/wms/reconciliador-oc.ts`, `src/lib/wms/varredura-validacao-oc.ts`, `src/lib/wms/contagem-inline.ts`.

**F2:**
- `supabase/migrations/20260514_wms_guarda_pendencias.sql:56` (coluna GENERATED).
- `supabase/migrations/20260527_p3_rpc_wms_confirmar_guarda_atomico.sql:48` (validação).
- `src/lib/wms/guarda.ts`, `src/lib/wms/putaway.ts`, `src/lib/wms/receber-oc.ts`.
- `src/lib/wms/roteamento.ts:262-267` (recebimento não-excluído).
- `siso_localizacao_locks`, `wms_replenishment_intra_galpao`, `siso_inventario_*`.

---

## 8. Riscos & mitigação

- **OC auto-aprovado sem reserva:** baixo — o worker re-checa estoque vivo; só vai pra `validacao_oc` o que falta de verdade (sem o que reservar). O que cobre vira própria com reserva.
- **Guarda dinâmica vs reserva no recebimento:** a "a guardar" usa `disponível` (saldo − reservado) pra não roubar peça de pedido que vai separar dali. Reservadas viajam pro picking.
- **Race guarda × picking:** resolvida pelo `FOR UPDATE` no estoque do recebimento dentro da RPC + lock ao iniciar.
- **`aprovar/route.ts` ramo OC vira código morto:** mencionar, não deletar nesta entrega (mudança cirúrgica).
- **Sumiço de pedido da fila (reconciliação automática):** já mitigado por `flag_saldo_apareceu` + invalidate realtime.

---

## 9. Fora de escopo
- Renomear "Esgotado".
- Seção amber separada na fila de pedidos (decidido: amber é no checklist).
- Migração de schema da coluna `qty_pendente`.
- Mudanças no fluxo de transferência.
- Auto-criação de OC sem humano (sem-cobertura segue o double-check do operador).
