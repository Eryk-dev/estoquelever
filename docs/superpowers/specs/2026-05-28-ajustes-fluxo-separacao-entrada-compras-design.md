# Ajustes do Fluxo de Pedido — Esgotado, Parcial na Entrada, Parcial na Separação e Aging de Compras

> **Design doc** · 2026-05-28 · valida-se contra o HTML de fluxo
> `docs/superpowers/specs/2026-05-28-revisao-fluxo-pedido-separacao-compras-fluxo.html`

## Contexto

O fluxo OC + Recebimento Unificado + Cross-docking
(`docs/superpowers/plans/2026-05-28-fluxo-oc-recebimento-crossdocking.md`) **já foi
100% implementado** hoje (Fases 1–3, ~20 commits). Logo depois, dois commits
(`873c9e5`, `e0d106a`) mudaram o comportamento do "esgotado" na separação pra
ir **direto pra Compras, sem modal**.

Esta spec **não reconstrói** nada disso. Ela refina 4 pontos do fluxo de pedido
que o operador (Eryk) validou como errados ou faltando, depois de olhar o mapa
visual do fluxo atual. Cada ajuste é cirúrgico e assenta sobre o código que já
existe.

**Fora de escopo:** recebimento unificado, cross-docking, bloqueio de OC com
saldo, "Encontrei sem cadastro" — tudo já implementado e não muda aqui.

## As 4 mudanças (validadas com o usuário)

### Mudança 1 — Esgotou: encaminhar pra outro galpão antes de comprar 🔄

**Hoje:** quando o operador marca Parcial + "a loc zerou" e o cascade não acha
o item em **nenhuma outra prateleira do mesmo galpão**, o sistema manda o item
**direto pra Compras**, sem perguntar, e joga o operador de volta pra lista
(commit `e0d106a`). A opção "encaminhar pra outro galpão" existe num caminho
separado (modal do `produto-esgotado`), mas **não aparece** nesse momento.

**Desejado (decisão do usuário):** ordem de precedência quando a loc zera e o
residual não é coberto no galpão atual:

1. **Outra prateleira no mesmo galpão** → realocação automática (já funciona, sem mudança).
2. **Não tem no galpão atual, mas tem em OUTRO galpão** → abre modal com
   **"Encaminhar para [Galpão X]"** como **primeira/principal** opção
   (botão verde), e "Mandar pra Compras" como opção secundária.
3. **Não tem em galpão nenhum** → vai **direto pra Compras**, sem modal
   (mantém o comportamento atual de `e0d106a` só pra este caso).

**Abordagem:**
- No backend do Parcial, quando o cascade do galpão atual retorna `sem_cobertura`,
  fazer uma checagem de disponibilidade do residual nos **demais galpões** (a
  lógica de "galpões alternativos" já existe em `produto-esgotado` →
  `galpoes_alternativos`). Retornar pro frontend um payload que distingue:
  - `tem_em_outro_galpao: true` + lista de galpões → frontend abre modal com
    encaminhar-first.
  - `tem_em_outro_galpao: false` → backend já manda pra Compras (comportamento atual).
- O modal usa as ações que **já existem**: "encaminhar" e "oc" do endpoint
  `produto-esgotado` (ou `mandar-pra-compras`). Não cria endpoint novo se der pra
  reusar.

**Ponto a confirmar na revisão:** ao **encaminhar pra outro galpão**, o pedido
inteiro hoje é resetado e movido pro galpão destino (re-separa do zero lá). Com
cross-dock implementado, há a alternativa de **só o item faltante viajar**
(picked items esperam, consolidam no destino). Recomendo **manter o reset/move
do pedido inteiro pro galpão destino** por ora (mais simples, previsível); o
operador encaminha quando percebe que o galpão atual não serve.

---

### Mudança 2 — Parcial na entrada: reserva o que tem, compra só o que falta 🆕

**Hoje:** quando um pedido chega e **um único galpão não cobre 100% dos itens**
(ex.: tem 2 de 3), o roteamento marca o pedido inteiro como `oc` (motivo
`split_galpoes` ou `sem_cobertura`), **sem reservar nada**. O pedido vai pro
painel, o operador aprova como OC, e o pedido **inteiro fica parado** em
"aguardando compra" — inclusive os itens que já existem em estoque (que ficam
livres pra outro pedido roubar).

**Desejado (decisão do usuário):** o pedido **não** deve ser segurado inteiro.
- **Reserva imediatamente** os itens que têm saldo (igual própria/transferência).
- Manda pra Compras **somente o(s) item(ns) que falta(m)**.
- Quando o item comprado chega, o pedido **separa e envia tudo junto**
  (1 nota, 1 envio — padrão marketplace). Não há envio parcial.

Efeito: a aba de Compras passa a mostrar **só o item a comprar**, não o pedido
inteiro; e os itens disponíveis ficam protegidos (reservados) desde a chegada.

**Abordagem:**
- O roteamento (`rotearPedidoDoBanco`) já calcula cobertura por item/galpão.
  Em vez de devolver `oc` monolítico quando a cobertura é parcial, devolver um
  resultado **misto**: itens cobertos (com galpão+loc pra reserva) + itens
  faltantes (pra compra).
- No processamento do webhook / na aprovação:
  - Criar **reserva R** pros itens cobertos (mesma mecânica de própria/transferência).
  - Marcar **só os itens faltantes** com `compra_status='aguardando_compra'`.
  - Pedido vai pra `status_separacao='aguardando_compra'` (espera o item faltante),
    **mas com os disponíveis já reservados**.
- A retomada pós-compra (`compras-release`) **já lida com pedido misto**
  (considera só os itens com decisão de compra no gate de release) — então
  quando o item faltante chega, o pedido retoma normalmente e separa todos juntos.

**Ponto a confirmar na revisão:** **onde** o split acontece —
(a) **automático no webhook** (reserva os disponíveis na hora; só o item faltante
vira tarefa de compra; pedido nunca aparece no painel "pendente"), ou
(b) **no painel de aprovação** (pedido aparece pro operador mostrando
"2 OK / 1 falta"; ao aprovar, reserva os disponíveis + manda o faltante pra Compras).
Recomendo **(b)** — mantém o operador no loop (consistente com o resto do fluxo)
e evita reservar automaticamente em casos de borda. Confirmar.

**Risco:** é a mudança mais profunda — toca roteamento + aprovação + reservas.
Precisa de cenários de teste cobrindo: pedido 2-de-3, item faltante chega e
envia junto, item disponível não é roubado por outro pedido enquanto espera.

---

### Mudança 3 — Parcial na separação (prateleira ainda tem): visível + fim da fila 🆕

**Hoje:** se o operador pega **parte** do item e a prateleira **não zerou**
(ex.: pediu 5, pegou 3, ainda tem lá), o item fica "em progresso":
`separacao_marcado=false` mas com `quantidade_pega` acumulada. Na tela **parece
não-marcado**, e o operador pode re-clicar achando que não fez nada → risco de
saída duplicada / confusão.

**Desejado (decisão do usuário):**
- O item aparece **visivelmente como "parcial"** no checklist (não como não-marcado).
- O pedido **volta pro fim da fila de separação** pra ser pego de novo numa
  passada posterior (quando reabastecer/sobrar tempo).

**Abordagem:**
- **Frontend (checklist):** renderizar um estado visual claro pro item parcial
  em progresso (badge "Parcial 3/5", cor âmbar), distinto de marcado e de
  não-marcado. Bloquear/avisar no re-clique (não criar saída duplicada).
- **Fila:** ao concluir a separação com algum item parcial-em-progresso, o pedido
  retorna pra `aguardando_separacao` preservando `quantidade_pega`, e é **ordenado
  no fim** da lista de separação (por timestamp de "voltou pra fila"). Numa
  próxima passada o operador pega o residual.

**Ponto a confirmar na revisão:** "fim da fila" = o **pedido inteiro** volta pra
`aguardando_separacao` (e some do wave atual), ou só o **item residual** fica
pendente enquanto o resto do pedido segue? Recomendo: **o pedido volta pra
aguardando_separacao** (consistente com "joga pro final da fila"), com os itens
já pegos preservados. Confirmar.

---

### Mudança 4 — Aba de Compras mostra tempo de espera 🆕

**Hoje:** a aba de Compras não mostra há quanto tempo um item/pedido está
esperando. Se o fornecedor atrasa, o pedido "some do radar".

**Desejado (decisão do usuário):** mostrar o **tempo de espera** de cada item/
pedido **somente na aba de Compras** (sem alerta global, sem mudar nenhum outro
lugar).

**Abordagem:**
- Backend da lista de Compras já tem o timestamp de quando o item entrou em
  compra (`compra_solicitada_em` ou equivalente). Expor esse tempo no payload.
- Frontend (`/wms/compras`): mostrar "esperando há X dias/horas" por item/
  fornecedor, com destaque visual leve pros mais antigos (ex.: âmbar > 3 dias,
  vermelho > 7). Sem disparar notificação nem mexer na home.

**Risco:** baixo — UI + um campo no payload.

## Faseamento recomendado

A dor principal do usuário é a separação. Sugiro:

- **Fase A (separação — a dor):** Mudança 1 (encaminhar-first) + Mudança 3
  (parcial visível + fila). São as que o operador sente todo dia.
- **Fase B (entrada split):** Mudança 2 — a mais profunda e arriscada, isolada
  numa fase própria com cenários dedicados.
- **Fase C (quick win):** Mudança 4 (aging em Compras) — pequena, pode entrar
  junto com a Fase A ou sozinha.

Cada fase entrega valor isolado e pode ser comitada/testada separadamente.

## Critérios de sucesso (verificáveis)

- **M1:** cenário — item esgota no galpão atual mas existe em outro → operador vê
  modal com "Encaminhar" primeiro; item que não existe em lugar nenhum → vai pra
  Compras sem modal.
- **M2:** cenário — pedido 2-de-3 → 2 itens ficam reservados, 1 vira compra; outro
  pedido não consegue reservar os 2 enquanto esperam; item comprado chega → pedido
  separa os 3 juntos.
- **M3:** cenário — pegou 3 de 5 sem zerar a loc → item mostra "Parcial 3/5", pedido
  volta pro fim de `aguardando_separacao` com `quantidade_pega=3` preservado.
- **M4:** visual — aba Compras mostra tempo de espera por item, mais antigos
  destacados.

## Pontos abertos pra revisão (resumo)

1. **M1:** encaminhar move o pedido inteiro pro galpão destino (recomendado) vs
   só o item viajar (cross-dock).
2. **M2:** split automático no webhook vs no painel de aprovação (recomendado).
3. **M3:** pedido inteiro volta pra fila (recomendado) vs só o item residual.
