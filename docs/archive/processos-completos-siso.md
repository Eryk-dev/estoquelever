# Mapa Completo de Processos — SISO

> Documento gerado em 2026-04-02. Linguagem de negocio, sem termos tecnicos.
> Objetivo: descrever com precisao absoluta tudo que acontece no sistema, incluindo casos especiais.

---

## Indice

1. [Chegada do Pedido](#1-chegada-do-pedido)
2. [Aprovacao do Pedido](#2-aprovacao-do-pedido)
3. [Execucao Pos-Aprovacao](#3-execucao-pos-aprovacao)
4. [Nota Fiscal](#4-nota-fiscal)
5. [Separacao (Wave Picking)](#5-separacao-wave-picking)
6. [Checklist OC (Validacao de Itens de Compra)](#6-checklist-oc-validacao-de-itens-de-compra)
7. [Embalagem](#7-embalagem)
8. [Expedicao](#8-expedicao)
9. [Compras (Modulo do Comprador)](#9-compras-modulo-do-comprador)
10. [Produto Esgotado Durante Separacao](#10-produto-esgotado-durante-separacao)
11. [Encaminhar Pedido Para Outro Galpao](#11-encaminhar-pedido-para-outro-galpao)
12. [Cancelamento de Pedido](#12-cancelamento-de-pedido)
13. [Etiquetas de Envio](#13-etiquetas-de-envio)
14. [Troca de SKU (Equivalente)](#14-troca-de-sku-equivalente)
15. [Cancelamento de Item de Compra](#15-cancelamento-de-item-de-compra)
16. [Item Indisponivel no Fornecedor](#16-item-indisponivel-no-fornecedor)
17. [Ajuste Manual de Estoque](#17-ajuste-manual-de-estoque)
18. [Voltar Etapa (Admin)](#18-voltar-etapa-admin)
19. [Forcar Pedido Pendente (Admin)](#19-forcar-pedido-pendente-admin)
20. [Reprocessamento de Webhooks](#20-reprocessamento-de-webhooks)
21. [Agrupamento e Pre-Cache de Etiquetas](#21-agrupamento-e-pre-cache-de-etiquetas)
22. [Inventario (DESATIVADO)](#22-inventario-desativado)
23. [Transferencia (DESATIVADO)](#23-transferencia-desativado)
24. [Etiquetas de Endereco (DESATIVADO)](#24-etiquetas-de-endereco-desativado)
25. [Lacunas e Alertas Identificados](#25-lacunas-e-alertas-identificados)

---

## 1. Chegada do Pedido

### O que acontece
Quando um cliente compra no Mercado Livre ou Shopee, o marketplace notifica o Tiny ERP. O Tiny por sua vez envia uma notificacao para o SISO dizendo "pedido aprovado" ou "pedido cancelado".

### Passo a passo

1. O Tiny envia a notificacao com o CNPJ da empresa que recebeu a venda e o numero do pedido.
2. O SISO identifica qual empresa (NetAir ou NetParts) recebeu o pedido pelo CNPJ.
3. O SISO verifica se ja recebeu essa mesma notificacao antes (para evitar processar duas vezes). Se ja recebeu, ignora.
4. Se o pedido foi **cancelado**, vai para o [fluxo de cancelamento](#12-cancelamento-de-pedido).
5. Se o pedido foi **aprovado**, o SISO busca os dados completos do pedido no Tiny (itens, quantidades, enderecos).
6. O SISO verifica se eh um pedido de marketplace. Se for um pedido interno/manual, ignora.

### Consulta de estoque (enriquecimento)

7. O SISO descobre a qual **grupo** a empresa pertence (ex: Autopecas).
8. Para **cada item** do pedido, o SISO consulta o estoque em **todas as empresas do grupo** — nao so na empresa que vendeu.
   - Exemplo: NetAir vendeu, mas o SISO consulta estoque na NetAir E na NetParts.
9. Para cada empresa, o SISO busca: saldo total, quantidade reservada, quantidade disponivel, e a localizacao fisica do produto no deposito.
10. Esses dados de estoque sao salvos no banco de dados, um registro por item por empresa.

### Decisao automatica (sugestao)

11. O SISO agrega o estoque por galpao (CWB e SP) e calcula a melhor forma de atender:

| Situacao | Decisao sugerida | O que acontece |
|---|---|---|
| O galpao de origem tem tudo | **Propria** | Atende com estoque proprio |
| Outro galpao tem tudo | **Transferencia** | Precisa pegar de outro galpao |
| Nenhum galpao tem tudo, mas um cobre mais | **Propria ou Transferencia** (o que cobrir mais) + **OC** para o restante | Parte do estoque + compra para o que falta |
| Ninguem tem nada | **OC** (Ordem de Compra) | Tudo precisa ser comprado |

12. **Auto-aprovacao**: Se a decisao eh "propria" (galpao de origem tem tudo), o pedido eh aprovado automaticamente sem ninguem precisar ver. O sistema ja enfileira o trabalho de baixa de estoque.

13. Em todos os outros casos, o pedido fica como **pendente** no painel SISO para o operador decidir.

### Casos especiais
- Se a mesma notificacao chegar duas vezes, a segunda eh ignorada silenciosamente.
- Pedidos que nao sao de marketplace (internos, manuais) sao ignorados.
- Se o CNPJ nao corresponde a nenhuma empresa cadastrada, a notificacao eh rejeitada.

---

## 2. Aprovacao do Pedido

### Quando acontece
Quando o pedido nao foi auto-aprovado (casos 2, 3 e 4 acima), o operador precisa aprovar manualmente no painel SISO.

### O que o operador ve
O operador ve o pedido com os itens, a sugestao do sistema (propria/transferencia/OC), e o estoque disponivel em cada galpao.

### O que o operador pode fazer

1. **Seguir a sugestao** — clica em aprovar com a decisao sugerida.
2. **Discordar da sugestao** — por exemplo, o sistema sugere transferencia porque o estoque aparece zerado, mas o operador sabe que tem estoque fisico. Nesse caso, ele pode ajustar o estoque manualmente (ver [Ajuste Manual de Estoque](#17-ajuste-manual-de-estoque)) e aprovar como "propria".
3. **Escolher OC** — mesmo que haja estoque parcial, o operador pode decidir comprar tudo.

### O que acontece ao aprovar

1. O pedido muda de "pendente" para "executando".
2. A decisao escolhida (propria, transferencia ou OC) eh registrada.
3. O sistema identifica em qual galpao o pedido sera separado:
   - **Propria**: no galpao de origem.
   - **Transferencia**: o sistema procura outra empresa do mesmo grupo em um galpao diferente. Se encontra, o pedido vai para la.
   - **OC**: no galpao de origem (por enquanto).
4. Um trabalho de "baixar estoque" eh enfileirado para processamento.
5. O status de separacao muda para "aguardando NF" (esperando a nota fiscal ser emitida).

### Caso especial
- Se o operador aprova como transferencia mas nao existe outra empresa no grupo, o sistema volta para a empresa de origem com um aviso no log.

---

## 3. Execucao Pos-Aprovacao

### O que eh
Depois que o pedido eh aprovado (manual ou automaticamente), o sistema precisa fazer operacoes no Tiny: emitir nota fiscal, baixar estoque, e criar o agrupamento de envio.

### Caminho A — Propria (estoque proprio)

1. Adiciona marcadores (tags) no pedido dentro do Tiny para identificar que esta sendo processado.
2. Gera a nota fiscal do pedido no Tiny.
3. Espera a nota fiscal ser autorizada pela SEFAZ (verifica por ate 30 segundos).
4. Baixa o estoque no Tiny com base na nota fiscal (o saldo diminui, a reserva some).
5. Marca no banco de dados que o estoque foi lancado.
6. Em paralelo (sem esperar): cria o agrupamento no Tiny para gerar a etiqueta de envio.
7. Marca o trabalho como concluido.

### Caminho B — Transferencia (estoque de outro galpao)

1. Adiciona marcadores no pedido do Tiny.
2. Gera a nota fiscal na empresa de origem (uma unica NF cobre todo o pedido).
3. Espera autorizacao da SEFAZ.
4. **Deducao de estoque especial**:
   - O sistema segue uma ordem de prioridade para decidir de qual empresa tirar o estoque:
     1. Empresa que recebeu o pedido (sempre primeira).
     2. Outras empresas no mesmo galpao (por ordem de tier/prioridade).
     3. Empresas em outros galpoes (por ordem de tier).
   - Para cada item, percorre essa lista ate encontrar uma empresa com estoque disponivel.
   - Baixa o estoque na nota fiscal da empresa de origem.
   - Para cada item que foi tirado de outra empresa: faz uma saida de estoque nessa empresa de suporte.
5. Marca estoque como lancado.
6. Cria agrupamento no Tiny (em paralelo).
7. Marca como concluido.

### Caminho C — OC (Ordem de Compra)

1. Adiciona marcadores no pedido do Tiny.
2. Gera a nota fiscal no Tiny.
3. Espera autorizacao da SEFAZ.
4. **Nao baixa estoque** — o estoque sera baixado depois, quando os itens comprados chegarem.
5. Identifica quais itens precisam ser comprados:
   - Agrupa por fornecedor (baseado no prefixo do SKU — ex: SKU comecando com "TG" = fornecedor Tiger).
   - Cria ordens de compra internas no SISO, uma por fornecedor.
   - Marca cada item com "aguardando compra".
6. O pedido fica com status de separacao "aguardando compra".
7. Cria agrupamento no Tiny (em paralelo, porque a NF ja existe).
8. Marca o trabalho como concluido (o fluxo de compras cuida do restante).

### Tentativas em caso de falha
- Se algo falhar, o sistema tenta ate 3 vezes com intervalos crescentes.
- Gerar nota fiscal eh seguro de repetir (nao cria duplicata).
- Baixar estoque so acontece se ainda nao foi marcado como lancado (evita baixa dupla).
- Criar agrupamento nunca impede que o trabalho seja marcado como concluido (falhas sao apenas registradas no log).

---

## 4. Nota Fiscal

### O que acontece quando a NF eh autorizada

A SEFAZ autoriza a nota fiscal e o Tiny notifica o SISO.

1. O SISO recebe a notificacao com o ID da nota fiscal.
2. Verifica se ja processou essa notificacao (evita duplicatas).
3. Busca os dados da NF no Tiny para descobrir a qual pedido pertence.
4. Verifica se eh uma NF de venda (ignora NFs de compra/transferencia).
5. **Sempre salva** os dados da NF no pedido (ID da NF, link do DANFE, chave de acesso), independente do status atual do pedido.
6. Se o pedido esta em "aguardando NF", muda para "aguardando separacao" — agora esta pronto para o separador.
7. Se o pedido ja esta em outro status (ex: ja foi para separacao), so salva os dados da NF e nao muda o status.
8. Em paralelo: tenta criar o agrupamento no Tiny antecipadamente (para a etiqueta de envio ficar pronta quando precisar).

### Casos especiais
- **NF chega antes do pedido**: O SISO nao encontra o pedido no banco e marca a notificacao como "aguardando pedido" para ser reprocessada depois.
- **NF chega depois que o pedido ja esta em separacao**: Os dados da NF sao salvos normalmente, sem alterar o status.
- **NF de compra ou transferencia**: Ignorada (so processa NF de venda).

---

## 5. Separacao (Wave Picking)

### Como funciona
O separador (operador no galpao) pega um conjunto de pedidos que estao "aguardando separacao" e inicia uma onda de separacao.

### Iniciar separacao

1. O operador seleciona os pedidos que quer separar (pode ser 1 ou varios).
2. O sistema gera uma **lista consolidada de produtos**: agrupa todos os itens de todos os pedidos selecionados por SKU, mostrando a quantidade total necessaria e a localizacao no deposito.
3. Todos os pedidos mudam para "em separacao".
4. Em paralelo: o sistema tenta criar agrupamentos e baixar etiquetas antecipadamente.

### Separar itens (checklist)

5. O operador vai ate a localizacao indicada e encontra o produto.
6. No tablet, **clica no checkbox** ao lado do item para marcar como separado.
   - Alternativa: pode bipar o codigo de barras (GTIN/SKU) no modo checklist, que marca o item automaticamente.
7. O operador repete para todos os itens da lista.

### Casos especiais da separacao
- O operador pode **desmarcar** um item (clicou errado).
- Se durante a separacao o operador nao encontra um produto, usa o fluxo de [Produto Esgotado](#10-produto-esgotado-durante-separacao).

### Concluir separacao

8. Quando todos os itens normais estao marcados, o operador conclui a separacao.
9. **Se o pedido so tem itens normais** (sem itens de compra): muda para "separado", pronto para embalar.
10. **Se o pedido tem itens de compra** (OC pendente): muda para "aguardando compra" — a separacao dos itens em estoque esta feita, mas precisa esperar os itens comprados chegarem.
11. Em paralelo: o sistema cria agrupamentos e baixa etiquetas para os pedidos que acabaram de ser separados.

---

## 6. Checklist OC (Validacao de Itens de Compra)

### Quando acontece
Quando o operador aprova um pedido como OC no painel SISO, o pedido cai na separacao com um campo destacado chamado "Checklist OC". Antes de ir para compras, o separador precisa confirmar se realmente nao tem o item em estoque.

### Passo a passo

1. O pedido aparece na separacao com status "validacao OC".
2. O separador ve os itens marcados como OC e vai verificar fisicamente.
3. Para cada item, tem duas opcoes:
   - **"Encontrei"**: O item estava no estoque (o sistema estava errado, ou alguem repôs). O item eh marcado como separado e sai do fluxo de compra.
   - **"Esgotado"**: Confirma que nao tem. O item eh enviado para o modulo de compras com status "aguardando compra", vinculado a uma ordem de compra.
4. O separador pode **desfazer** o "Encontrei" se clicou errado — o item volta para OC pendente.

### Transicoes automaticas

- Se **todos** os itens forem marcados como "Encontrei": o pedido muda para decisao "propria" e volta para "aguardando separacao" (pronto para ser separado normalmente).
- Se **todos** os itens forem confirmados como "Esgotado" e 100% do pedido eh OC: o pedido vai direto para "aguardando compra".
- Se for **misto** (alguns encontrados, outros esgotados): nao faz transicao automatica — o operador conclui a separacao dos itens encontrados e os esgotados vao para compras.

### Pick OC (Separacao direta de itens de compra)

Quando os itens de compra chegam, existe uma opcao alternativa chamada "Pick OC":

1. O operador seleciona os pedidos no Pick OC e inicia a separacao.
2. Marca todos os itens (incluindo os de compra).
3. Ao concluir via "Concluir OC":
   - Os itens de compra sao marcados automaticamente como "recebidos".
   - O sistema decide se eh propria ou transferencia (comparando o galpao da OC com o galpao de origem).
   - Enfileira um trabalho de baixa de estoque no Tiny.
   - O pedido muda direto para "separado".
   - A tag "pick oc" eh adicionada ao pedido.

---

## 7. Embalagem

### Como funciona
Depois que o pedido esta "separado", o embalador pega os itens e embala.

### Passo a passo

1. O embalador bipa o codigo de barras de cada produto.
2. O sistema encontra o pedido mais antigo que esta "separado" e tem aquele SKU (FIFO — primeiro que entrou, primeiro que sai).
3. A cada bipagem, incrementa o contador de itens embalados daquele pedido.
4. **Quando todos os itens de um pedido sao bipados**: a etiqueta de envio eh impressa automaticamente na impressora termica.
5. O pedido muda para "embalado".

### Alternativa: confirmacao manual
Em vez de bipar, o embalador pode usar botoes +/- para confirmar a quantidade de cada item manualmente.

### Embalagem direta de OC
Quando itens de compra chegam, o comprador pode preparar os pedidos para embalagem direta (sem passar pela separacao):

1. O comprador seleciona as ordens de compra recebidas.
2. O sistema pega todos os pedidos vinculados a essas OCs.
3. Pedidos que ja estao prontos (aguardando separacao, em separacao, separado) sao movidos direto para "separado".
4. Todos os itens sao marcados como separados.
5. Em paralelo: agrupamentos sao criados e etiquetas baixadas.
6. O embalador pode entao bipar/confirmar e o pedido segue para embalado.

### Caso especial: OC na embalagem
Se o embalador confirma um item de um pedido que esta em "aguardando compra" (OC com embalagem direta):
- O sistema automaticamente resolve os itens de compra como "recebidos".
- Decide propria ou transferencia.
- Enfileira trabalho de baixa de estoque.
- Imprime etiqueta.
- O pedido pula direto para "embalado".

### Diagnostico quando bipagem nao encontra nada
Se o embalador bipa um produto e o sistema nao encontra, ele explica por que:
- "Ja foi bipado completo" (todos os itens desse SKU ja foram embalados)
- "Pedido nao esta separado" (ainda em separacao)
- "Pertence a outro galpao" (este galpao nao pode embalar)
- "Item cancelado ou indisponivel"

---

## 8. Expedicao

### Como funciona
Depois que o pedido esta "embalado" e a etiqueta foi impressa, o operador marca como expedido.

### Passo a passo

1. O operador seleciona os pedidos embalados.
2. O sistema valida que todos estao "embalados" e pertencem ao galpao do operador.
3. Os pedidos mudam para "expedido".

### Validacoes
- Somente operadores do galpao correto podem expedir.
- Admin precisa ter um galpao associado.
- Todos os pedidos precisam estar "embalados".

---

## 9. Compras (Modulo do Comprador)

### Visao geral
Quando itens de um pedido precisam ser comprados (decisao OC), eles aparecem no modulo de compras. O comprador faz a compra externamente (liga para o fornecedor, faz pedido online, etc.) e registra no SISO.

### Aba "Comprar" — Itens aguardando compra

1. Os itens aparecem agrupados por fornecedor e SKU.
2. O comprador seleciona os itens e registra a compra:
   - Informa a quantidade comprada.
   - O sistema distribui a quantidade entre os pedidos mais antigos primeiro (FIFO).
3. Os itens mudam de "aguardando compra" para "comprado".
4. Uma ordem de compra eh criada (ou reutilizada se ja existe um rascunho para o mesmo fornecedor e galpao).

### Aba "Receber" — Itens comprados aguardando chegada

1. Quando os itens chegam fisicamente, o comprador registra o recebimento:
   - Informa o SKU e a quantidade recebida.
   - Aceita recebimento parcial (chegou so metade, o resto vem depois).
2. Os itens mudam de "comprado" para "recebido" (quando a quantidade recebida atinge a solicitada).

### Liberacao automatica do pedido

3. Quando **todos** os itens de compra de um pedido sao marcados como "recebido" (ou cancelado):
   - O sistema reavalia a decisao:
     - Se o galpao da OC eh o mesmo do galpao de origem: decisao "propria".
     - Se eh diferente: decisao "transferencia".
   - Verifica se a NF ja chegou:
     - Se sim: pedido vai para "aguardando separacao".
     - Se nao: pedido vai para "aguardando NF".
   - Enfileira um novo trabalho de baixa de estoque.

### Devolver item para fila
O comprador pode devolver um item ja comprado de volta para "aguardando compra" (ex: fornecedor cancelou o pedido). O item eh desvinculado da ordem de compra.

---

## 10. Produto Esgotado Durante Separacao

### Quando acontece
O separador foi buscar um produto no deposito e nao encontrou. O estoque do sistema estava errado.

### O que o sistema oferece

1. **Primeiro, preview**: O sistema verifica se outro galpao tem estoque desse SKU e mostra as alternativas.

2. **Opcao 1 — Encaminhar para outro galpao**: Se outro galpao tem estoque:
   - Todos os pedidos em separacao que precisam desse SKU sao movidos para o outro galpao.
   - O progresso de separacao eh resetado (checkmarks desmarcados).
   - Os pedidos ficam "aguardando separacao" no galpao destino.
   - **ATENCAO**: Este encaminhamento via "produto esgotado" **NAO estorna estoque no Tiny**. Eh diferente do [Encaminhar Pedido](#11-encaminhar-pedido-para-outro-galpao) que estorna.

3. **Opcao 2 — Criar OC**: Se ninguem tem estoque (ou o operador prefere comprar):
   - Os itens desse SKU em todos os pedidos ativos sao marcados como "aguardando compra".
   - O progresso de separacao eh resetado.
   - Uma ordem de compra eh criada automaticamente para o fornecedor correto (baseado no prefixo do SKU).
   - Os pedidos mudam para "aguardando compra".

### Itens afetados
Nao eh so o pedido atual — todos os pedidos em separacao que contem aquele SKU sao afetados de uma vez.

---

## 11. Encaminhar Pedido Para Outro Galpao

### Quando acontece
O operador decide que um pedido deve ser atendido por outro galpao. Diferente do "produto esgotado", aqui eh uma decisao do operador por pedido especifico.

### Pre-condicoes
- O pedido deve estar em "aguardando separacao" ou "em separacao".
- O galpao destino deve ser diferente do atual.
- O galpao destino deve existir e estar ativo.

### O que acontece

1. **Estorno de estoque no Tiny** (se aplicavel):
   - Se a decisao era "propria" e o estoque ja foi baixado: o sistema **estorna o estoque automaticamente** no Tiny (reverte a saida).
   - Se a decisao era "transferencia" e o estoque ja foi baixado: o sistema **faz uma entrada reversa** em cada empresa que teve estoque deduzido (devolvendo o estoque item por item).
   - Se a decisao era "OC" ou o estoque nao foi baixado: nao precisa estornar nada.

2. **Reset do pedido**:
   - O pedido volta para "pendente" com sugestao de "transferencia".
   - A decisao final, operador, timestamps de separacao — tudo eh limpo.
   - O estoque eh marcado como "nao lancado".
   - **A nota fiscal eh preservada** (ela pertence ao pedido, nao ao galpao).
   - Os artefatos de envio sao limpos (agrupamento, expedicao, etiqueta) — serao recriados no novo galpao.

3. **Reset dos itens**:
   - Checkmarks de separacao desmarcados.
   - Bipagens zeradas.
   - Empresa de deducao limpa.

4. O pedido reaparece no painel SISO para re-aprovacao.

### Caso especial
- Se um item foi deduzido de outra empresa mas nao tem o ID do produto nessa empresa, o estorno falha com erro (o pedido nao consegue ser encaminhado).

---

## 12. Cancelamento de Pedido

### Via webhook do Tiny (automatico)
Quando o marketplace cancela o pedido, o Tiny envia uma notificacao de cancelamento.

1. O SISO recebe a notificacao.
2. Se o pedido existe no banco:
   - Status muda para "cancelado".
   - Status de separacao eh limpo.
   - Se o pedido estava no fluxo de compras:
     - Todos os campos de compra dos itens sao limpos.
     - O vinculo com ordens de compra eh removido.
     - Ordens de compra que ficam vazias sao canceladas automaticamente.
     - **Se algum item ja tinha recebido estoque de compra** (quantidade recebida > 0): um alerta eh setado no pedido (`compra_estoque_lancado_alerta`), mas **o estoque NAO eh estornado automaticamente no Tiny**.
   - Trabalhos pendentes na fila de execucao sao cancelados.

### LACUNA IDENTIFICADA — Cancelamento nao estorna estoque
**O cancelamento via webhook NAO estorna o estoque que ja foi baixado no Tiny.** Se o pedido ja passou pela execucao (estoque foi baixado), o estoque fica incorreto no Tiny. O sistema apenas seta um alerta. Alguem precisa corrigir manualmente.

### Via modulo de compras (manual)
O comprador pode cancelar um pedido inteiro pelo modulo de compras:

1. Todos os itens de compra sao marcados como cancelados.
2. O pedido muda para "cancelado".
3. Trabalhos pendentes sao cancelados.
4. O pedido eh cancelado no Tiny (se ainda nao estava cancelado la).
5. Se algum item ja tinha recebido estoque: alerta eh setado (mesmo problema — sem estorno automatico).

---

## 13. Etiquetas de Envio

### O que sao
Sao as etiquetas de envio do marketplace (Mercado Livre, Shopee) impressas em papel termico na impressora do galpao.

### Quando sao impressas
A etiqueta eh impressa automaticamente quando o ultimo item de um pedido eh bipado na embalagem.

### Como funciona por dentro

1. O sistema tenta usar a etiqueta que ja foi baixada e cacheada (caminho rapido — ~200ms).
2. Se nao tem cache, precisa buscar no Tiny (caminho lento — ~3-5s):
   - Verifica se o agrupamento ja foi criado no Tiny.
   - Se nao, cria um novo agrupamento.
   - Conclui o agrupamento.
   - Busca a expedicao vinculada.
   - Baixa o arquivo da etiqueta (formato ZPL, vem dentro de um ZIP).
   - Salva no cache para uso futuro.
3. Identifica a impressora do galpao (configurada nas definicoes).
4. Envia para a impressora via PrintNode.
5. Registra se a impressao foi bem sucedida ou falhou.

### Reimprimir
O operador pode reimprimir uma etiqueta de um pedido ja embalado. Se o cache existe, usa direto. Se nao, refaz todo o processo.

### Retry de etiqueta
Se a etiqueta falhou (agrupamento nao criou, download falhou, etc.), o operador pode tentar novamente. O sistema re-tenta criar o agrupamento e baixar a etiqueta.

### Pre-cache (agrupamento antecipado)
O sistema tenta criar agrupamentos e baixar etiquetas antes de precisar delas:
- **Fase 1 (cedo)**: Assim que a NF eh autorizada, cria o agrupamento no Tiny e descobre o ID da expedicao. Nao baixa a etiqueta ainda.
- **Fase 2 (na conclusao da separacao)**: Quando a separacao termina, cria agrupamentos para quem ainda nao tem e baixa todas as etiquetas.
- Isso faz com que na hora de embalar, a etiqueta ja esteja pronta e a impressao seja rapida.

### Mecanismo anti-duplicata
Somente um processo pode imprimir a etiqueta de um pedido por vez (mecanismo atomico de "claim"). Se dois operadores bipam o mesmo pedido ao mesmo tempo, so um imprime.

---

## 14. Troca de SKU (Equivalente)

### Quando acontece
O comprador descobre que o SKU que precisa comprar esta indisponivel no fornecedor, mas existe um produto equivalente com outro SKU.

### Fluxo completo

1. **Propor equivalente**: O comprador informa o novo SKU.
   - O sistema busca o produto no Tiny e carrega os dados (descricao, imagem, GTIN, fornecedor).
   - Salva os dados do equivalente no item.
   - Salva tambem os dados originais (SKU original, descricao original, produto ID original) para rastreabilidade.
   - O item muda para "equivalente pendente".
   - O item eh desvinculado da ordem de compra (a OC eh cancelada se ficar vazia).
   - **Pre-condicao**: Nao pode ter quantidade ja recebida (se ja recebeu estoque, nao da para trocar).

2. **Confirmar equivalente**: Depois que a troca eh efetivada externamente.
   - O item eh atualizado com os dados do produto equivalente (novo SKU, descricao, imagem, fornecedor).
   - Os registros de estoque antigos sao apagados.
   - Novos registros de estoque sao criados consultando o Tiny para todas as empresas do grupo.
   - O item volta para "aguardando compra" com o novo SKU.
   - **Validacao**: Se o pedido ja tem outro item com o mesmo produto ID do equivalente, a troca eh rejeitada (evita duplicata).

### Troca de SKU simples (sem fluxo equivalente)
Existe tambem uma troca de SKU mais simples que atualiza o SKU de um item diretamente:
- Busca o novo produto no Tiny em todas as empresas do grupo.
- Atualiza descricao, imagem, fornecedor.
- Recria os registros de estoque com dados atualizados.
- Nao muda o status de compra.

---

## 15. Cancelamento de Item de Compra

### Fluxo em duas etapas

1. **Propor cancelamento**: O comprador marca o item como "cancelamento pendente".
   - O item eh desvinculado da OC (OC cancelada se ficar vazia).
   - Motivo opcional eh registrado.

2. **Confirmar cancelamento**: Depois que o cancelamento eh efetivado externamente.
   - Os registros de estoque do item sao deletados.
   - O item eh marcado como "cancelado".
   - Checkmarks de separacao sao limpos.
   - **Se todos os itens do pedido estao em estado terminal** (cancelado ou indisponivel): o pedido inteiro eh cancelado.
   - Se nem todos estao terminal mas os de compra restantes estao resolvidos: o sistema verifica se pode liberar o pedido para separacao.

---

## 16. Item Indisponivel no Fornecedor

### Quando acontece
O comprador tentou comprar e o fornecedor nao tem o item.

### O que acontece
1. O item eh marcado como "indisponivel".
2. Os dados de compra sao limpos (quantidade comprada, quem comprou, etc.).
3. O item eh desvinculado da OC (OC cancelada se ficar vazia).
4. **Se todos os itens do pedido estao em estado terminal**: o pedido inteiro eh cancelado.

### Diferenca para cancelamento
- Indisponivel: o fornecedor nao tem. O comprador pode depois propor um equivalente ou cancelar.
- Cancelamento: decisao firme de nao atender o item.

---

## 17. Ajuste Manual de Estoque

### Quando eh usado
Quando o estoque do sistema nao bate com o estoque fisico. O operador ajusta manualmente.

### O que acontece

1. O operador informa o produto, o galpao e a nova quantidade.
2. O sistema faz um **balanco** (ajuste absoluto) no Tiny: seta o estoque para o valor informado.
3. Depois, busca o estoque atualizado do Tiny (para confirmar o valor real).
4. Atualiza os registros de estoque no banco de dados do SISO.

### Detalhe importante
- Se o ajuste eh no galpao de origem, usa o ID do produto diretamente.
- Se eh em outro galpao (suporte), usa o ID do produto equivalente naquela empresa.

---

## 18. Voltar Etapa (Admin)

### O que eh
Funcao exclusiva do admin para mover pedidos para frente ou para tras no fluxo de separacao.

### O que pode fazer
- Mover para qualquer status: aguardando compra, aguardando NF, validacao OC, aguardando separacao, em separacao, separado, embalado.
- **Indo para tras**: limpa os timestamps das etapas futuras, reseta checkmarks e bipagens conforme necessario.
- **Indo para frente**: seta timestamps e marca itens como concluidos.

### Cuidados
- Dados de etiqueta e agrupamento **nao sao limpos** (mesmo indo para tras).
- Status da etiqueta eh resetado quando volta para etapas anteriores a separado.

---

## 19. Forcar Pedido Pendente (Admin)

### Quando eh usado
Quando um pedido esta preso em "aguardando NF" mas o admin sabe que a NF ja foi autorizada (o webhook pode ter falhado).

### O que acontece
1. O admin seleciona os pedidos presos.
2. O sistema consulta o Tiny para verificar se a NF esta de fato autorizada.
3. Se esta autorizada: o pedido muda para "aguardando separacao" e salva a chave de acesso.
4. Se nao esta autorizada: o pedido permanece em "aguardando NF" e aparece na lista de "nao autorizados".
5. Em paralelo: tenta criar o agrupamento antecipadamente.

---

## 20. Reprocessamento de Webhooks

### Quando eh usado
Quando houve falha no processamento de webhooks (bug que foi corrigido, timeout, etc.) e os pedidos ficaram presos.

### O que acontece
1. O sistema busca todas as notificacoes pendentes com status "pendente" e tipo "aprovado".
2. Para cada uma, re-executa o processamento completo (consultar estoque, calcular decisao, etc.).

---

## 21. Agrupamento e Pre-Cache de Etiquetas

### O que eh agrupamento
No Tiny, um "agrupamento" eh uma entidade que agrupa uma ou mais notas fiscais para envio. Eh necessario para gerar a etiqueta de envio do marketplace.

### Duas fases

**Fase 1 — Criacao antecipada (assim que a NF existe)**
- Criado em paralelo, sem bloquear nenhum processo.
- Cria o agrupamento no Tiny com a nota fiscal.
- Tenta concluir o agrupamento (pode falhar se o marketplace controla a coleta — Mercado Envios).
- Descobre o ID da expedicao.
- **Nao baixa a etiqueta** nesse momento.

**Fase 2 — Na conclusao da separacao**
- Para pedidos que ainda nao tem agrupamento: cria agora.
- Para pedidos que tem agrupamento mas nao tem etiqueta: baixa a etiqueta do Tiny (arquivo ZPL dentro de um ZIP).
- Salva tudo no banco para uso rapido na embalagem.

### Protecoes
- Se um agrupamento ficou "preso" (marcado como pendente por mais de 5 minutos), eh liberado para nova tentativa.
- Apenas um processo por vez pode criar o agrupamento de um pedido (mecanismo atomico).
- Se o agrupamento some do Tiny (ex: foi deletado), o ID eh limpo e ele eh recriado.

---

## 22. Inventario (DESATIVADO)

> Os modulos de inventario, transferencia e etiquetas de endereco estao atualmente desativados.

### O que fazia quando ativo

1. O operador criava uma sessao de inventario para uma empresa.
2. Escolhia o modo: localizacao + estoque (ajusta saldo) ou so localizacao.
3. Bipava produtos no deposito, informando localizacao e quantidade.
4. Ao processar:
   - Para cada SKU, agrupava as quantidades.
   - Consultava o estoque atual no Tiny.
   - Fazia o ajuste de estoque no Tiny (balanco, entrada ou saida).
   - Atualizava a localizacao do produto no Tiny.
5. Podia reverter o inventario (desfazer todos os ajustes):
   - Restaurava a localizacao original.
   - Revertia os movimentos de estoque.
6. Produtos tipo Kit nao tinham ajuste de estoque (somente localizacao).
7. Suportava retomada em caso de interrupcao (processava apenas itens pendentes).

---

## 23. Transferencia (DESATIVADO)

### O que fazia quando ativo

1. O operador criava uma transferencia entre duas empresas (origem e destino).
2. Bipava produtos da empresa de origem.
3. Ao processar:
   - Para cada item:
     - Verificava se o produto existia na empresa destino.
     - Se nao existia: **clonava o produto** (criava uma copia no Tiny da empresa destino com os mesmos dados).
     - **Primeiro**, dava entrada no destino (mais seguro — se falhar, ninguem perde estoque).
     - **Depois**, dava saida na origem.
4. Podia reverter:
   - Dava entrada na origem.
   - Dava saida no destino.

### Detalhe sobre clonagem
O produto clonado recebe os mesmos dados (nome, SKU, preco, GTIN, unidade, NCM, origem). Um flag "clonado" eh marcado para rastreabilidade.

---

## 24. Etiquetas de Endereco (DESATIVADO)

### O que fazia quando ativo
Gerava etiquetas com enderecos de localizacao de deposito (ex: "A01-B02-C03") em formato ZPL e imprimia na impressora termica. Dois tamanhos: pequena (2 por etiqueta) e grande (1 por etiqueta rotacionada).

---

## 25. Lacunas e Alertas Identificados

### LACUNA 1 — Cancelamento nao estorna estoque no Tiny
**Gravidade: ALTA**

Quando um pedido eh cancelado via webhook do Tiny (ex: marketplace cancelou), o SISO marca o pedido como cancelado mas **NAO estorna o estoque que ja foi baixado no Tiny**. Se o pedido ja passou pela execucao:
- **Decisao "propria"**: O estoque que foi baixado via nota fiscal permanece baixado.
- **Decisao "transferencia"**: Os movimentos de estoque nas empresas de suporte permanecem.

O sistema apenas seta um alerta (`compra_estoque_lancado_alerta`) e registra um warning no log. Alguem precisa corrigir manualmente.

**Comparacao**: O fluxo de [Encaminhar](#11-encaminhar-pedido-para-outro-galpao) FAZ estorno automatico. O cancelamento deveria fazer o mesmo.

### LACUNA 2 — Produto esgotado "encaminhar" nao estorna estoque
**Gravidade: MEDIA**

Quando o separador marca um produto como esgotado e escolhe "encaminhar para outro galpao", o sistema move os pedidos mas **nao estorna estoque que ja possa ter sido baixado**. Diferente do "Encaminhar Pedido" (item 11) que faz estorno completo.

Isso pode nao ser um problema na pratica se o produto esgotado so afeta pedidos que ainda nao tiveram estoque baixado (estao em separacao, nao em execucao). Mas se por alguma razao o estoque ja foi baixado, haveria inconsistencia.

### LACUNA 3 — Cancelamento de pedido com estoque ja recebido de compra
**Gravidade: MEDIA**

Quando um pedido eh cancelado e alguns itens de compra ja tinham sido recebidos (estoque ja entrou no Tiny via o fornecedor), o sistema seta um alerta mas nao toma nenhuma acao sobre esse estoque recebido. O estoque de compra fica "sobrando" no Tiny sem contrapartida.

### OBSERVACAO — Fila de execucao e pedidos cancelados
O sistema cancela trabalhos pendentes na fila quando um pedido eh cancelado, o que eh correto. Mas se o trabalho ja foi executado (estoque ja baixado), nao ha mecanismo automatico de reversao.

---

## Mapa de Status de Separacao

```
                                    ┌─────────────────┐
                                    │  aguardando_nf   │
                                    │ (esperando NF)   │
                                    └────────┬─────────┘
                                             │ NF autorizada
                                             v
┌───────────────┐    aprovar OC     ┌─────────────────┐
│  validacao_oc  │◄────────────────│aguardando_       │
│  (checklist)   │                  │ separacao         │
└───────┬────┬──┘                  └────────┬─────────┘
        │    │                              │ iniciar
        │    │ todos encontrei              v
        │    └─────────────────────►┌─────────────────┐
        │                           │  em_separacao    │
        │ todos esgotado            │ (separando)      │
        v                          └────────┬─────────┘
┌───────────────┐                           │ concluir
│ aguardando_   │◄──── itens OC ────────────┤
│ compra        │                           v
│ (compras)     │                  ┌─────────────────┐
└───────┬───────┘                  │    separado      │
        │ itens recebidos          │ (pronto embalar) │
        └─────────────────────────►└────────┬─────────┘
                                            │ bipar embalagem
                                            v
                                   ┌─────────────────┐
                                   │    embalado      │
                                   │ (etiqueta ok)    │
                                   └────────┬─────────┘
                                            │ expedir
                                            v
                                   ┌─────────────────┐
                                   │    expedido      │
                                   │ (enviado)        │
                                   └─────────────────┘
```

---

## Mapeamento SKU → Fornecedor → Galpao

| Prefixo do SKU | Fornecedor | Galpao que recebe a OC |
|---|---|---|
| 19 | Diversos | CWB |
| EW, TG | Tiger | SP |
| LD | LDRU | SP |
| L0 | LEFS | SP |
| 6 digitos numericos | ACA | CWB |
| GB, GE, GS, GI | GAUSS | CWB |
| MK, M0, B0 | MRMK | SP |
| CAK, CS | Delphi | SP |
| KT | Kintop | SP |
| MQ, APX, WDC, AT, FD, FI, GM, HO, HY, KI, MAN, MB, NI, PG, RN, SC, TO, UN, VO, VW, AG, BI, BA | Multiqualita | CWB |
| Qualquer outro | Diversos (fallback) | CWB |
