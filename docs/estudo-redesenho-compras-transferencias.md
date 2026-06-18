# Estudo de Redesenho — Compras + Transferências

> Estudo de design (não é plano de implementação ainda). Base: pesquisa de padrões da
> indústria (NetSuite, Odoo, SAP B1/S4, Cin7 Core, Brightpearl, ShipHero, Dynamics 365,
> Linnworks, Inventory Planner) + mapeamento profundo do código atual do SISO.
> Data: 2026-06-18.

---

## 0. Resposta direta à pergunta do Eryk

**"Devo parar de agrupar por fornecedor e agrupar só por SKU, deixando o comprador decidir de onde comprar?"**

**SIM — esse é o padrão moderno de TODOS os sistemas líderes.** A lista do comprador é
**item-cêntrica** (uma linha por produto), o fornecedor é um **atributo editável da linha**,
e o sistema **consolida automaticamente em OCs por (fornecedor, galpão)** no momento de
"Gerar OC" — o comprador nunca agrupa na mão.

- NetSuite "Order Items": uma linha por produto, comprador confirma/troca o fornecedor por
  linha, ao Submeter o sistema gera **1 OC por fornecedor (e por local)**.
- Odoo "Replenishment": linha por produto, coluna Vendor editável, agrupa RFQ por fornecedor.
- Cin7 "Smart Reorder", Unleashed "Reorder Report", Katana, Fishbowl: idem.

O trabalho cognitivo do comprador é **decidir o fornecedor certo por SKU**; agrupar em OCs é
trabalho da máquina. Agrupar por fornecedor na tela força o comprador a pensar em lotes-de-
fornecedor antes de ter o quadro completo.

---

## 1. Como os melhores fazem (consenso condensado)

| Tema | Padrão dominante |
|---|---|
| **Estrutura da lista** | 1 linha por SKU (ou SKU×destino). Fornecedor = atributo da linha. |
| **Fornecedor por linha** | Pré-preenche o preferencial do cadastro; editável; dropdown com preço/lead/MOQ por fornecedor. |
| **Consolidação em OC** | Chave = **(fornecedor, galpão destino)**. Mesmo fornecedor, 2 destinos = 2 OCs. Automático no "Gerar OC". |
| **Destino (ship-to)** | No cabeçalho da OC, derivado do destino da linha. Nunca misturado numa OC só. |
| **Necessidade líquida** | `demanda − em_mãos − em_trânsito + estoque_segurança` (MRP clássico). |
| **Dois sinais de compra** | Lane A reativa (pedido sem estoque → compra) **+** Lane B proativa (ponto de reposição / DDMRP). Coexistem no mesmo SKU; deduplica netando contra OC pendente. |
| **MOQ / múltiplo** | Aplicados à qtd sugerida **depois** da necessidade líquida (arredonda pra cima). |
| **Pegging (vínculo)** | Cada linha de OC guarda os pedidos que cobre; na entrada, libera FIFO pra esses pedidos. |
| **Transferência (STO)** | Documento de 1ª classe com estado **em-trânsito** (peça sai do disponível da origem, entra no destino só ao receber) + fila de separação na origem + tela "chegando" no destino. |
| **Reroute vs Transfer** | **Reroute** = mover a reserva pra outro galpão (sem mover peça). **Transfer** = mover peça física. São coisas diferentes. |
| **Ruptura → compra** | Operador não acha no pick → libera reserva → vira backorder/OC, pegado ao pedido. |

Fontes principais: NetSuite Order Items / Pegging; Odoo Reordering Rules + MTO; SAP STO type UB;
ShipHero Transfer Order; Cin7 Location Supply Rules; D365 DDMRP + Purchase Requisition. (URLs no anexo.)

---

## 2. Onde o SISO está hoje (gaps concretos)

| # | Gap | Evidência |
|---|---|---|
| G1 | **Lista agrupa por fornecedor, fornecedor+galpão vêm de mapa de PREFIXO hardcoded** (`sku-fornecedor.ts`), **desconectado** de `siso_produto_fornecedores` (preço/lead/MOQ/múltiplo/multi-fornecedor/preferencial). A tabela boa existe e a tela ignora. | `compras/route.ts:460` usa `getFornecedorBySku().filialOC`; tabela rica em `20260522_wms_roteamento.sql` |
| G2 | **Galpão destino só editável no modal de comprar**, some depois (OC criada = travado). Consolida por SKU, não dá pra mandar pedido #123→SP e #124→CWB no mesmo SKU. | `comprar/route.ts:242,300`; modal `page.tsx:1222` |
| G3 | **`em_transito` é global** (somado entre galpões), pode mis-netar: OC chegando em CWB reduz a necessidade de SP. | `compras/route.ts:264-282` |
| G4 | ~~MOQ/múltiplo não aplicados~~ → **FORA DE ESCOPO por decisão (2026-06-18):** comprador digita a quantidade; sugestão é a necessidade pura, sem arredondar. | — |
| G5 | **Só Lane A (reativa).** Sem reabastecimento proativo — só compra quando um pedido específico não acha estoque. Fast-movers só disparam compra DEPOIS de já ter rompido. | sem ROP/DDMRP no código |
| G6 | **OC criada em 2 lugares** com resolução de galpão divergente; um sem proteção de corrida (23505). Índice único é parcial (OC com galpão null fica desprotegida). | `comprar/route.ts:401` vs `validar-oc-item:1234`; `20260611p` |
| G7 | **Transferência física não é fluxo de operador.** `siso_transferencias_galpao` existe mas: sem fila de separação na origem, sem tela "chegando" no destino, sem estado em-trânsito claro no ledger. | `transferencias.ts`; aprovação só flipa galpão |
| G8 | **Encaminhar travado a 3 status** (`aguardando_separacao/em_separacao/pendente_realocacao`). OC (`aguardando_compra/validacao_oc`) e `aguardando_nf` não redirecionam por aí. Sem permissão própria (session-only). | `encaminhar/route.ts:131` |
| G9 | **Sem caminho de ruptura no pick.** Operador que não acha a peça não tem botão "não achei → vira compra". | — |
| G10 | **Pegging invisível.** O reconciliador casa entrada↔pedido por FIFO (`sku, separacao_galpao_id, status`), mas o comprador não vê "esta OC destrava os pedidos X, Y, Z". | `reconciliador-oc.ts:93` |

**O que JÁ está certo (não quebrar):** necessidade líquida reativa (fórmula MRP de período único, correta);
ledger `disponivel = saldo − reservado` (ATP físico correto); reservas atômicas; reconciliador FIFO por
`criado_em`; `siso_produto_fornecedores` (modelo multi-fornecedor canônico, equivalente ao SAP PIR).

---

## 3. Modelo proposto — COMPRAS (item-cêntrico)

### 3.1 A lista (a "necessidade de compras")

Uma linha **por SKU** que precisa comprar. Colunas:

```
[ ] SKU + descrição + imagem
    Quanto comprar  (campo EDITÁVEL; vem com a sugestão = necessidade líquida pura)
    Fornecedor ▼    (preferencial do cadastro, editável; dropdown com preço + lead por fornecedor)
    Preço un.       (última compra do fornecedor escolhido)
    Galpão destino ▼ (editável; default = onde está a maior demanda)
    Pedidos         (chip "3 pedidos · mais antigo 4d" → expande e mostra cada pedido + galpão dele)
    Urgência        (cobertura: crítico/atenção/ok · dias de cobertura)
```

- Expandir a linha mostra os **pedidos atrás daquela necessidade** (pegging visível) com o galpão atual de cada um.
- **Fonte de fornecedor = `siso_produto_fornecedores`** (preferencial + alternativos), NÃO o mapa de prefixo. O prefix map vira só **seed/fallback** quando o SKU não tem fornecedor cadastrado.
- **Necessidade líquida por galpão:** `max(0, demanda_aberta − estoque_livre − em_transito)` com **em_transito escopado por galpão** (corrige G3).
- **Quantidade editável:** a sugestão = necessidade líquida pura; o **comprador digita** quantas unidades vai comprar. SEM caixa/mínimo/múltiplo (decisão 2026-06-18 — G4 fica fora de escopo, não aplicar arredondamento).

### 3.2 Gerar OC (consolidação automática)

Comprador marca as linhas → **"Gerar OCs"** → sistema cria **1 OC por (fornecedor, galpão destino)**.
Sem agrupar na mão. Cada item de pedido vira linha da OC, **pegado** aos pedidos que cobre.

- Resolver os **2 criadores de OC duplicados** num único helper compartilhado, race-safe (corrige G6).
- Índice único cobrindo também o caso galpão-null.

### 3.3 Destino editável até receber

Coluna "Galpão destino" trocável **a qualquer momento até a mercadoria chegar** (antes/na/depois de gerar OC).
Trocar = atômico: re-aponta `separacao_galpao_id` do pedido **+** `siso_ordens_compra.galpao_id`. O
reconciliador passa a casar a entrada no galpão certo. **Resolve o caso Curitiba→SP** (corrige G2).

### 3.4 Pegging visível

Na OC: "esta OC destrava os pedidos X, Y, Z". Na entrada (mov E), libera FIFO pra esses pedidos
(reconciliador já faz — só expor) (corrige G10).

### 3.5 (Opcional) Lane B proativa

Sinal de reabastecimento por **ponto de reposição** (ROP = giro × lead + segurança) ou **DDMRP** (buffers)
pra fast-movers (curva A), independente de pedido. Gera sugestão de compra ANTES de romper. Coexiste com a
Lane A reativa, deduplicando contra OC pendente. **Candidato a fase 2** (corrige G5).

---

## 4. Modelo proposto — TRANSFERÊNCIAS

Separar **dois conceitos** com nomes distintos (hoje "encaminhar" mistura):

### 4.1 Redirecionar pedido (reroute) — sem mover peça

Mover o fulfillment de um pedido pra outro galpão. Libera a reserva na origem, re-decide/re-reserva no
destino. É o "encaminhar" de hoje, **generalizado pra todos os status antes de bipar**
(`aguardando_compra`, `validacao_oc`, `aguardando_nf`, `aguardando_separacao`, `em_separacao`) — decisão Q2.
Não mexe em quem já bipou. Adicionar permissão própria (corrige G8).

### 4.2 Transferência de estoque (STO) — mover peça física

Quando a peça precisa SAIR de um galpão e ENTRAR em outro. Documento de 1ª classe (padrão ShipHero):

```
Comprador/gestor cria transferência (origem, destino, itens, motivo/pedido)
  → reserva na origem
ORIGEM (operador): fila "transferências a despachar" (igual pick) → separa → "Despachar"
  → peça sai do DISPONÍVEL da origem (estado EM-TRÂNSITO)
DESTINO (operador): tela "chegando" (esperado) → confere qtd → "Receber"
  → peça entra no disponível do destino → pode destravar pedido
```

Reusa pick (origem) e recebimento (destino) que já existem — operador usa a mesma muscle-memory.
`siso_transferencias_galpao` já tem a estrutura; falta a UX + o estado em-trânsito explícito (corrige G7).

### 4.3 Ruptura no pick → vira compra (decisão Q3)

Operador separando não acha a peça (estoque fantasma) → botão **"não achei"** → estorna a reserva, item
vira `aguardando_compra`, cai na lista de compras. Comprador escolhe fornecedor + galpão (ex: SP).
**Fecha o caso Curitiba→SP de ponta a ponta** (corrige G9).

---

## 5. Matriz de opções (decisões do Eryk)

| # | Decisão | Opção A (recomendada) | Opção B | Opção C |
|---|---|---|---|---|
| O1 | Granularidade da linha | 1 linha por SKU, expansível pros pedidos; escolhe 1 destino (ou divide) | 1 linha por SKU×galpão | — |
| O2 | Pedido multi-item sem 1 galpão cobrindo 100% | **Consolidar** num galpão (transfere o que falta, 1 envio) | **Split** (cada galpão manda sua parte) | Manter como hoje (vira OC) |
| O3 | Lane B proativa (ROP/DDMRP) | Sim, **fase 2** | Sim, agora | Não (só reativo) |
| O4 | Transferência física | Documento completo (fila origem + chegando destino + em-trânsito) | Versão leve agora, completa depois | — |
| O5 | Drop-ship (fornecedor→cliente) | Fora de escopo | Incluir (peças raras/caras) | — |

---

## 6. Recomendação + faseamento sugerido

**Fase 1 — Núcleo de compras item-cêntrico (maior valor, menor risco):**
1. Lista por SKU lendo `siso_produto_fornecedores` (fornecedor/preço/lead/MOQ editável por linha) — mata G1.
2. `em_transito` por galpão — mata G3. (G4 fora: sem arredondamento; comprador digita a quantidade.)
3. Helper único de criação de OC, race-safe + índice — mata G6.
4. Consolidação "Gerar OC" por (fornecedor, galpão) + destino editável até receber — mata G2.
5. Pegging visível — mata G10.

**Fase 2 — Transferências & ruptura:**
6. Redirecionar pedido generalizado (Q2) + permissão — mata G8.
7. Transferência física de 1ª classe (Q3/O4) — mata G7.
8. Ruptura "não achei" → compra — mata G9.

**Fase 3 — Proativo (se O3=sim):**
9. Lane B (ROP/DDMRP) pra curva A — mata G5.

Cada fase é entregável e testável isolada. Tudo TDD (teste que reproduz → passa), em staging.

---

## 7. Decisões travadas (2026-06-18)

| Fork | Decisão | Consequência |
|---|---|---|
| O1 Linha da lista | **1 linha por SKU**, expansível pros pedidos atrás | Comprador escolhe 1 galpão destino por compra (ou divide manualmente) |
| O2 Pedido multi-item sem 1 galpão cobrindo 100% | **Manter como hoje** (vira OC `sem_cobertura`) | Roteamento NÃO auto-consolida nem faz split. Transferência é ferramenta manual, não disparada pelo roteamento |
| O3 Reposição proativa (Lane B) | **Sim — reusando `siso_cobertura_estoque`** | Falta só a **cobertura-alvo** (dias de estoque a manter). Default global `lead_time+7d`, ajustável depois por produto/curva |
| O4 Transferência física | **Documento completo** | Fila "a despachar" na origem + tela "chegando" no destino + estado em-trânsito no ledger. Reusa pick/recebimento |
| Q2 Transferir antes de bipar | **Sim, todos os status pré-bipagem** | Generaliza encaminhar; não mexe em quem já bipou |
| Q3 Ruptura "não achei" → OC | **Sim** | Operador libera reserva → item vira `aguardando_compra` → cai na lista de compras |

### Cobertura-alvo (Lane B) — viabilidade confirmada
`siso_cobertura_estoque` (MV, refresh 1min, `20260607_fix_cobertura_3d.sql`) já entrega por
(produto, galpão): `giro_diario`, `disponivel_total`, `dias_cobertura`, `lead_time_medio`,
`status_cobertura ∈ {sem_giro, critico<7d, atencao<14d, lead_time_risco, ok}`. É o ponto de
reposição pronto. Sugestão proativa = `max(0, giro × cobertura_alvo − disponivel − em_transito)`,
lendo o fornecedor preferencial de `siso_produto_fornecedores`. A sugestão é só um número
**editável** (comprador ajusta), igual à Lane A. Única peça nova: a **cobertura-alvo** (knob). Sem infra nova.

### Faseamento final
- **Fase 1 — Compras item-cêntrico:** lista por SKU lendo `siso_produto_fornecedores` (G1);
  `em_transito` por galpão (G3) + quantidade editável pelo comprador (G4 fora: sem arredondar); helper único de OC race-safe (G6);
  "Gerar OC" consolida por (fornecedor, galpão) + destino editável até receber (G2); pegging visível (G10).
- **Fase 2 — Transferências & ruptura:** redirecionar pedido pré-bipagem + permissão (G8, Q2);
  transferência física de 1ª classe (G7, O4); ruptura "não achei" → OC (G9, Q3).
- **Fase 3 — Reposição proativa:** Lane B sobre cobertura + cobertura-alvo (G5, O3).

---

## Anexo — Fontes

- NetSuite Order Items / Pegging / AOM / MOQ — docs.oracle.com (ns-online-help)
- Odoo Reordering Rules, MTO, Resupply Warehouses — odoo.com/documentation/18.0
- SAP STO type UB; SAP EWM Cross-Docking — help.sap.com, learning.sap.com
- Cin7 Core Smart Reorder + Location Supply Rules — help.core.cin7.com
- Brightpearl Inventory Transfers + Demand Planner — help.brightpearl.com
- ShipHero Transfer Order — software-help.shiphero.com
- Dynamics 365 DDMRP + Purchase Requisition + Confirm & Transfer — learn.microsoft.com
- Inventory Planner (Sage); Unleashed Reorder Report; Linnworks Replenishment; Fishbowl Purchasing
- MRP/ATP/DRP/Safety Stock — APICS/ASCM; usersolutions.com; mecalux.com; netstock.com; MIT (King)
