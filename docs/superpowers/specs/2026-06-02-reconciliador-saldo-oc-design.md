# Reconciliador de saldo OC — devolver pedido ao picking quando o estoque chega

**Data:** 2026-06-02
**Diagrama de fluxo (revisão visual):** [`2026-06-02-reconciliador-saldo-oc-fluxo.html`](./2026-06-02-reconciliador-saldo-oc-fluxo.html)
**Status:** desenho aprovado pelo usuário (aguardando review do spec → writing-plans)

---

## 1. Problema

A decisão de roteamento (`propria | transferencia | oc`) é tomada **uma única vez** (no webhook, e recalculada só na aprovação humana / no worker). Depois disso, **nada reage** quando o estoque muda. Quando um item vai para a trilha de compra (`Esgotado`) e o estoque chega **depois**, o item fica **preso** — continua exibindo `Encontrei/Esgotado` no checklist mesmo com `disponivel > 0`, e nunca volta ao picking normal.

Sintoma relatado (ACD003): item aprovado como OC → operador marca Esgotado → estoque chega → continua em "Esgotados", para sempre.

### Causa-raiz (confirmada no código — investigação de 7 agentes)

- **`roteamento.ts`** decide uma vez; não há loop de re-avaliação.
- **`varredura-validacao-oc.ts`** (único gancho em mov `E`, disparado por `ledger.ts:230-256`) só seta `flag_saldo_apareceu=true` em pedidos `status_separacao='validacao_oc'` — efeito puramente cosmético (banner), e nem cobre `aguardando_compra`.
- **Checklist** (`checklist/page.tsx` `isOcStatus()`) decide o balde 100% por `compra_status`, ignorando o saldo vivo. `recebido` continua no balde OC.
- **Dois caminhos de recebimento divergentes:** `/api/wms/compras/receber` libera o pedido (`checkAndReleasePedidos`); `/api/wms/receber/oc/[id]` (`receberItensViaOC`) **não** seta `recebido` nem libera → item recebido fisicamente fica preso em `aguardando_compra` (classe de bug já em `erros-conhecidos.yaml:420-437`).

## 2. Decisões do usuário (entrada deste desenho)

1. **Comportamento:** quando aparece estoque para um item na trilha OC/Esgotado, o sistema **devolve sozinho ao picking** (automático, não exige clique).
2. **Condição de gatilho:** só usa estoque **genuinamente livre** — `disponivel` (saldo − reservado) **depois de honrar todas as reservas existentes**. Nunca rouba reserva de outro pedido.
3. **Disputa:** **FIFO** — pedido mais antigo parado leva o estoque livre primeiro; libera quem couber, deixa o resto na compra.
4. **Limite no ciclo de compra (confirmado no diagrama):** age sobre itens **ainda não comprados**. Item **já comprado** (PO emitida/paga) **mantém a compra** e segue pelo recebimento.

## 3. Escopo

### Mecanismo 1 — Reconciliador event-driven (o coração)
Para itens **não comprados** (`compra_status IN ('oc_pendente','aguardando_compra')`), em pedidos `status_separacao IN ('validacao_oc','aguardando_compra')`: ao entrar estoque, devolve ao picking por FIFO usando só saldo livre.

### Mecanismo 2 — Unificar os dois recebimentos (conserto acoplado)
Para itens **já comprados** (`comprado`), garantir que **qualquer** recebimento da OC seta `recebido` e chama `checkAndReleasePedidos`. Sem isso, o "preso pra sempre" persiste no caminho de compra real.

### Fora de escopo (anotado para depois)
- Fulfillment **multi-galpão** (soma de galpões cobre, mas nenhum sozinho) — `roteamento.ts` GAP 9.
- Refactor de **centralizar as ~15 transições de `compra_status`** numa state-machine única — GAP 10.
- Mudar o bucketing do checklist (não é preciso: o reconciliador zera `compra_status`, então o item vira pick normal automaticamente).

## 4. Arquitetura

### 4.1 Onde vive
Evoluir o gancho existente: `inserirMovimentacao` (`ledger.ts`) já dispara `varrerPedidosAfetadosPorEntrada` **fire-and-forget após cada mov `tipo='E'`**. Substituir essa varredura "só banner" por um **reconciliador** de verdade. (Reservas são `tipo='R'`, não `E` → **não há recursão** no gancho.)

Novo módulo: `src/lib/wms/reconciliador-oc.ts` — função pura de orquestração `reconciliarEntradaEstoque(produtoId, galpaoId)` chamada pelo gancho.

**Decisão sobre o banner `flag_saldo_apareceu`:** é **mantido**, mas passa a sinalizar só o que o reconciliador **não resolve sozinho** — ou seja, quando o saldo apareceu mas é **parcial/insuficiente** para cobrir o pedido (item fica na compra, operador fica ciente). Para os casos **cobertos**, a liberação automática já tira o item da fila, então o banner é irrelevante (o item sumiu do balde OC). Resultado: nada de aviso "fantasma" para item que já voltou ao picking.

### 4.2 Algoritmo (por `produto_id, galpao_id` afetado pela entrada `E`)

```
1. saldoLivre = disponivel(produto, galpao)            # saldo − reservado, live de siso_estoque
2. pedidosParados = itens com compra_status IN (oc_pendente, aguardando_compra)
                    desse produto, no galpao de separação,
                    em pedidos status_separacao IN (validacao_oc, aguardando_compra)
3. ordena pedidosParados por DATA REAL do pedido (mais antigo primeiro)
   # NÃO usar pedido_id textual (lexicográfico é frágil — ver GAP do roteamento)
4. para cada pedido (FIFO):
     faltaDoItem = quantidade − já_pega − realocs_picadas
     se saldoLivre >= faltaDoItem:
        a. cria reserva R atômica (wms_reservar_atomico) p/ faltaDoItem
           — reusa o caminho de criarReservasPedido (seleção por localização,
             prefere tipo='picking', TTL 30d, anti-oversell)
        b. se a reserva falhar (corrida / saldo sumiu) → trata como "não coube", pula
        c. compra_status = null; limpa compra_quantidade_solicitada, ordem_compra_id,
           fornecedor_oc; desvincula/cancela a OC pendente do item
           (se a OC ficar sem itens → cancela o cabeçalho da OC)
        d. saldoLivre -= faltaDoItem
     senão:
        deixa na compra (próxima entrada tenta de novo)
5. recomputa status do pedido (reusa a transição FR-9 de validar-oc-item):
     se não sobra item oc_pendente/aguardando_compra e há item pickável →
        decisao_final='propria', status_separacao = (era validacao_oc/aguardando_compra
        ? 'aguardando_separacao' : mantém em_separacao)
```

### 4.3 Atomicidade & concorrência
- A criação da reserva usa a RPC atômica existente (`wms_reservar_atomico` → `wms_inserir_movimentacao`, lock pessimista + valida saldo/reservado). **Nunca reserva além do que existe** (resolve "saldo fantasma").
- O loop FIFO em app-code tem janela TOCTOU entre ler `saldoLivre` e reservar. **Mitigação:** a RPC é a fonte da verdade — se a reserva falhar por saldo insuficiente, o reconciliador pula o pedido (passo 4b); pior caso, o pedido é liberado na próxima entrada `E`. **Sem oversell** em nenhuma corrida.
- Idempotência: como a liberação zera `compra_status` e cria a R, uma segunda passada não encontra mais o item em `pedidosParados`. Reentrância segura.

### 4.4 Mecanismo 2 — unificação dos recebimentos
Extrair/garantir que `receberItensViaOC` (`receber-oc.ts`) e `/api/wms/compras/receber` compartilhem o mesmo fechamento: ao atingir `compra_quantidade_recebida >= compra_quantidade_solicitada`, setar `compra_status='recebido'` e chamar `checkAndReleasePedidos`. Idealmente uma função única `fecharRecebimentoItemOC()` usada pelos dois caminhos.

## 5. Fluxo de dados (resumo)

```
mov E (recebimento | transferência | ajuste | inventário | devolução)
  → inserirMovimentacao (ledger.ts) [fire-and-forget]
    → reconciliarEntradaEstoque(produto, galpao)        [Mecanismo 1]
        → FIFO release: R atômica + compra_status=null + desvincula OC + status pedido
  (se for recebimento formal de item 'comprado')
    → fecharRecebimentoItemOC → compra_status='recebido' → checkAndReleasePedidos  [Mecanismo 2]
```

## 6. Casos de borda / erros (cada um vira teste)

| Caso | Comportamento esperado |
|---|---|
| Saldo cobre só alguns pedidos | FIFO: libera o(s) mais antigo(s) coberto(s), resto fica na compra |
| Estoque reservado p/ outro pedido | só conta `disponivel`; não toca reservas (sem oversell) |
| Saldo fantasma (aviso sem físico) | RPC atômica falha a reserva → não libera nada |
| Pedido misto (normal + OC) | libera só o item OC coberto; pedido segue com os dois |
| Item já comprado | reconciliador **ignora**; mantém a compra; libera via recebimento (Mec. 2) |
| Reserva falha por corrida | pula o pedido; libera na próxima entrada `E` |
| OC vinculada vira órfã | ao zerar o item, desvincula; OC sem itens → cancelada |

## 7. Estratégia de testes

- **Unit (vitest):** `reconciliarEntradaEstoque` como função orientável — FIFO, respeito à reserva, partial coverage, pedido misto, idempotência, item-já-comprado-ignorado. (Padrão da casa: extrair a lógica pura, ex. `distribuir-qty-pega.ts`.)
- **Integration (staging real):** entrada `E` → reconciliação → reserva criada + `compra_status` zerado + `status_separacao` correto, respeitando reservas pré-existentes.
- **Cenário E2E (`scripts/wms/cenarios/`):** novo cenário "estoque chega para item esgotado → volta pro picking FIFO" (espelhar o estilo do cenário 69).
- **Regressão:** `erros-conhecidos.yaml:420-437` (preso em `aguardando_compra` com recebido≥solicitado) deve passar a destravar.

## 8. Documentação a atualizar (mesmo commit)

- `CLAUDE.md` (pipeline / gotcha sobre re-roteamento por entrada de estoque).
- `docs/architecture-and-flows.md` + `docs/fluxos-siso.md` (novo passo de reconciliação).
- `docs/api-reference-complete.md` se a rota de recebimento mudar de contrato.
- `erros-conhecidos.yaml` (entrada da correção).

## 9. Riscos

- Toca caminho que **move estoco/reserva real** — exige testes fortes antes de mexer no release.
- `criarReservasPedido` / seleção de localização precisa lidar com qty espalhada em várias locs do galpão (mesma limitação `buscarLinha` do roteamento — validar no plano).
- `linkItemToOC`/`findOrCreateOC` usam `siso_empresas.galpao_id` (DEPRECADA) — ao desvincular/cancelar OC, não reintroduzir dependência nessa coluna.
