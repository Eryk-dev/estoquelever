# Picklist de implementação — Raio-X SISO/WMS

**Como usar:** percorra os itens, troque `[ ]` por `[x]` no que você quer fazer, e escreva sua decisão na linha **MINHA ESCOLHA** (ex: "opção A", ou texto livre). Depois mande este arquivo pro outro chat dizendo:

> "Implemente os itens marcados com [x] neste arquivo, seguindo a MINHA ESCOLHA de cada um. Pra cada item: primeiro um teste que reproduz, depois o conserto."

IDs: **P###** = problema (bug confirmado) · **D###** = decisão sua. "Código" é o ponteiro pro implementador achar o trecho.

Total: 185 problemas + 316 decisões.

---

# 🔴 PROBLEMAS (bugs confirmados) — 185

## P001 — Pedido com zero unidades entra no sistema
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Quando um pedido novo chega e o sistema decide de qual galpão sai
- **Imagina assim:** Quando o Tiny envia um pedido com um item que tem quantidade = 0
- **Hoje:** O sistema aceita o item com zero unidades e tenta processar. Ele busca uma prateleira para guardar esse nada. Consegue achar (porque a busca sempre retorna algo). Mas no final, quando tenta atualizar o saldo de verdade, falha com mensagem de erro.
- **Por que importa:** O pedido inteiro fica travado. Ninguém vê que o problema é um item com zero unidades. Operador não sabe se é erro do Tiny ou do sistema.
- **Opções:** (A) Validar quando entra um pedido (recusar pedido inteiro se qualquer item tiver qty=0) → Tiny fica com pedido não entregue. Obriga loja a enviar correto. Mais claro.  ·  (B) Pular o item (continuar com outros itens do pedido) → Pedido segue parcial. Risco: cliente pagou por 3 itens, recebe 2. Precisa de alerta visual.
- **Recomendação:** Opção 1. Validar na chegada e rejeitar. Mais seguro. Sistema avisa qual item errado pra Tiny corrigir.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:46

## P002 — Uma peça do kit não tem código cadastrado no Tiny dessa empresa
- [ ] **vou fazer** · gravidade: grave · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Quando um pedido novo chega e o sistema decide de qual galpão sai
- **Imagina assim:** Um kit K tem 2 unidades do componente C1 e 3 unidades do componente C2. Quando o pedido entra, o sistema tenta expandir esse kit. Mas a peça C1 não tem código cadastrado no Tiny dessa empresa (cada empresa tem a própria conta no Tiny, com códigos próprios).
- **Hoje:** O sistema avisa que a peça C1 não tem código no Tiny dessa empresa (escreve um aviso no log), mas continua mesmo assim. C1 é ignorado. O pedido sai com apenas C2 (3 unidades). Se há estoque de C2, o pedido é aprovado incompleto. Cliente recebe só C2, falta C1.
- **Por que importa:** Kit saído incompleto. Cliente recebe menos do que pagou. Devolução certa. Operador não vê que o pedido está quebrado até o cliente reclamar.
- **Opções:** (A) Parar na chegada: avisar 'componente X não existe nessa empresa, ajuste o cadastro' → Força configurar o mapeamento antes de vender. Zera erro incompleto.  ·  (B) Ignorar componente e processar kit parcial (hoje) → Cliente recebe kit incompleto. Reclamação e devolução.
- **Recomendação:** Opção 1. Parar na chegada. Mais seguro. Força o cadastro estar correto antes de qualquer pedido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/webhook-processor-wms.ts:238-245

## P003 — Dois cliques admin no reprocessamento criam duas reservas idênticas
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Quando um pedido novo chega e o sistema decide de qual galpão sai
- **Imagina assim:** Um admin clica o botão 'reprocessar pedido' duas vezes muito rápido (menos de 1 segundo entre um clique e outro) no mesmo pedido.
- **Hoje:** Primeira ação e segunda ação chegam ao sistema quase no mesmo instante. O sistema tenta verificar se o pedido já foi processado, mas por causa da velocidade, ambas acham que é primeira vez. Cria duas reservas iguais. Estoque fica contado errado. Saldo mostra que estão reservadas 10 unidades quando deveriam ser 5.
- **Por que importa:** Saldo fica mentindo. Pode aprovar pedidos quando não deveria (vendeu estoque que não existe). Ou bloqueia vendas legítimas por achar que não tem mais.
- **Opções:** (A) Adicionar trava antes de processar: somente um processamento por vez por pedido → Segundo clique aguarda primeiro terminar. Zero duplicação. Mais lento em ms, mas seguro.  ·  (B) Usar data e hora: se foi processado há menos de 30 segundos, pular (hoje usa apenas flag, não tempo) → Melhor que hoje, mas ainda pode falhar se dois chegam ao mesmo tempo.
- **Recomendação:** Opção 1. Trava pessimista. Elimina totalmente o risco. Operacional é mais seguro que rápido aqui.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/webhook-processor-wms.ts:435-456

## P004 — Mercadoria do pedido muda enquanto o sistema está aprovando
- [ ] **vou fazer** · gravidade: grave · tema: Estoque apartado pros pedidos (reservas) · fluxo: Aprovação de Pedidos e Compras
- **Imagina assim:** #99999 com 4 itens. Operador aprova. Enquanto o sistema apartava os itens na reserva, uma devolução chegou pela loja e o item 3 sumiu de um dia pro outro (qtd de 10 caiu pra 0).
- **Hoje:** O sistema apartou a mercadoria do item 3 com 10 unidades, mas como a informação mudou na origem, a reserva fica órfã — o estoque apartado é de um item que não existe mais no pedido.
- **Por que importa:** Sua rotina de acerto de saldo vai ficar confusa: o sistema reporta estoque apartado em coisa que não veio no pedido. Pode atrasar a entrega e gerar dúvida sobre o que realmente precisa sair.
- **Opções:** (A) Trancar a mercadoria no momento que o operador clica em aprovar, liberando o travamento só quando termina. → Garante que nenhuma devolução ou cancelamento atrapalhe no meio do caminho. Mais seguro, mas mais lento.  ·  (B) Depois que apartou tudo, conferir de novo se a mercadoria ainda bate com o pedido original. → Se mudou, avisa o operador e volta tudo ao normal. Menos travamento, mas precisa de uma conferência extra.  ·  (C) Deixar como está e contar com a rotina de acerto de saldo pra limpar isso depois. → Nada muda agora, mas o acerto vai ter que detectar e corrigir apartamentos órfãos.
- **Recomendação:** Use a opção 2 (conferência rápida). Seu sistema já tem a rotina de acerto, então pode confiar nela pra os casos raros. Mas antes que a rotina rode, avise o operador pra que saiba que algo mudou.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/aprovar/route.ts:495-512 + 516-588

## P005 — Pedido aprovado fica preso quando a tarefa de soltar o estoque não entra na fila
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Aprovação de Pedidos e Compras
- **Imagina assim:** Pedido 444 (exemplo): o operador aprova e o sistema atualiza o status pra 'em processamento'. Mas o aviso pra soltar o estoque (tarefa da fila) nunca sai do computador.
- **Hoje:** A base de dados gravou que o pedido foi aprovado (status = em processamento). Mas a tarefa que deveria soltar o estoque reservado simplesmente não entrou na fila. O sistema diz 'pronto' pro operador, mas ninguém avisou a retaguarda que tem mercadoria pra separar.
- **Por que importa:** O operador acredita que terminou o trabalho. Você acha que o pedido já saiu, mas ele fica parado na retaguarda porque nenhuma separação foi disparada. O cliente reclama que demora.
- **Opções:** (A) O sistema retorna erro se a fila falhar (volta o pedido pra 'pendente' pra o operador tentar de novo). → Operador sabe que algo deu errado e refaz. Mais seguro, mas pede esforço manual.  ·  (B) A tarefa é repetida automaticamente se falhar, e o sistema é tolerante a duplicatas. → Nenhuma ação manual do operador. Mas precisa de mais código pra evitar que a mesma separação rode duas vezes.  ·  (C) Deixar como está e monitorar os pedidos travados manualmente na rotina de acerto. → Seu operador detecta e força o reprocessamento. Simples, mas depende de vigilância.
- **Recomendação:** Use a opção 2. Sua equipe não tem tempo pra monitorar cada falha. Deixe o sistema ser robusto: a tarefa se rejeita se a fila falhar, entra em uma fila de retentativas, e o operador só fica sabendo se der muito errado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/aprovar/route.ts:352-359

## P006 — Quando a separação trava no meio, ninguém descobre pelo histórico
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Acompanhamento de pedido — do que chega até sair do galpão
- **Imagina assim:** Pedido PED-ERROR-001 com 10 produtos. Separador marca 8 produtos, mas no nono tenta procurar em uma prateleira que não existe mais (foi recontada ou reorganizada). Sistema dá erro, mas não registra nada no histórico.
- **Hoje:** O separador não sabe que travou de verdade — o sistema continua dizendo 'em separação', mas nada acontece. O operador tem que cavar nos detalhes técnicos pra descobrir qual item causou o problema.
- **Por que importa:** Quando um pedido trava, você precisa saber rapidamente o quê exatamente causou — qual produto, qual prateleira, por quê. Sem isso, o pedido fica invisível no histórico e ninguém consegue destravar rápido.
- **Opções:** (A) Registrar automaticamente todos os erros de separação no histórico (qual prateleira não existe, qual quantidade está faltando, etc.) → Operador vê imediatamente 'Tentou buscar produto ABC na prateleira L-45-02-03, mas prateleira não existe'. Consegue destravar ou avisar compras rápido.  ·  (B) Deixar como está — operador segue clicando em detalhes pra investigar → Pedidos ficam lentos de resolver, operador gasta tempo procurando onde está o problema.
- **Recomendação:** Implemente automaticamente — custa pouco e economiza muito tempo de investigação. Todo erro de separação deve virar uma anotação visível no histórico do pedido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** Nao encontrei registro de 'erro' em separation routes; historico-service.ts lista 'erro' como possível evento linha 60

## P007 — Cancelamento de pedido que está sendo separado: alguns itens já foram picados, outros não
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Pedido com 2 itens no estoque: o item 1 já foi marcado como separado (pego do monte), mas o item 2 ainda está no monte. O operador tenta cancelar o pedido inteiro.
- **Hoje:** O sistema libera o estoque apartado dos dois itens, mas deixa o pedido marcado como 'cancelado' enquanto o item 1 já foi fisicamente retirado. O saldo volta a aparecer como disponível para vender, mas a situação fica confusa: o estoque já saiu do monte para a pessoa, mas o sistema diz que foi cancelado.
- **Por que importa:** Se o operador não se atender bem, pode contar o item 1 duas vezes: uma vez nos dedos dele (que está com o item) e outra vez como 'estoque cancelado' que voltou pro monte. O cliente pode ficar sem receber enquanto a mercadoria fica perdida entre o monte e a pessoa.
- **Opções:** (A) Bloquear: se separação está ativa, proibir cancelamento e avisar 'termine de separar antes de cancelar' → Operador é forçado a devolver o item 1 antes de cancelar. Mais seguro, mas mais trabalhoso.  ·  (B) Cancelar só o que não foi pego: liberar estoque do item 2 e devolver item 1 de forma manual (operador refaz a entrada) → Mais flexível, mas precisa de novo fluxo de devolução. Gasta tempo.
- **Recomendação:** Bloquear o cancelamento enquanto há separação ativa. Avisar: 'Cancele cada item que já foi pego usando o menu de devolução; depois cancele o pedido inteiro.'
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/vendas-cancelamento.ts:61-64

## P008 — Cancelamento gera duplicação de estoque quando há tarefas do sistema enfileiradas
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Pedido foi aprovado e o sistema colocou uma tarefa em fila pra processar (exemplo: preparar o estoque). Antes da tarefa ser executada, o operador cancela o pedido.
- **Hoje:** O cancelamento cria um registro de estorno do estoque apartado. Depois, quando a tarefa da fila chega a vez de rodar, o sistema vê que o estoque ainda está apartado (no status antigo) e tenta processar de novo. Resultado: o mesmo estoque é liberado duas vezes — fica disponível para vender em duas ocasiões diferentes. O saldo fica errado.
- **Por que importa:** Imagine que você tem 100 unidades. Aprova um pedido de 10 (fica 90 disponível, 10 apartado). Antes da máquina processar, cancela. O sistema libera 10 duas vezes: na primeira vez fica 100, e quando a máquina chega, libera 10 de novo (fica 110). Seu saldo fica fantasiado — pode vender mais do que existe.
- **Opções:** (A) Cancelar a tarefa na fila quando o pedido é cancelado → Evita duplicação. Limpo e correto.  ·  (B) Deixar a tarefa rolar (ela percebe que já foi desfeita e não tenta de novo) → Mais seguro porque mesmo que algo der errado, não duplica. Mas mais código.
- **Recomendação:** Cancelar a tarefa enfileirada junto com o cancelamento do pedido. Se a tarefa já começou, deixa rodar normal (sem duplicação).
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/[id]/estornar/route.ts

## P009 — [CONFERIR — pode não ser bug] Estorno do pedido: o estoque volta e o pedido vira cancelado
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Pedido foi separado e o sistema registrou a saída do estoque (nota fiscal lançada). Depois, o operador clica cancelar.
- **Hoje:** Lendo o código real: o estorno desfaz cada saída e cada reserva do pedido (o estoque volta pro monte) SEM apagar nada — fica registrada a saída E a reversão, lado a lado. Depois marca o pedido como cancelado. Importante: NÃO existe status 'aguardando saída' (foi termo inventado na análise) e este botão NÃO cancela nota fiscal nenhuma. Pelo código, isto parece estar correto.
- **Por que importa:** O saldo volta certo e a trilha fica completa (saída + reversão registradas). Provavelmente NÃO é um bug. Só valeria mexer se sobrar alguma marca interna de 'estoque já lançado' que não é limpa após o estorno — isso precisa ser conferido antes de tratar como problema.
- **Opções:** (A) Resetar para 'aguardando saída' e deixar novo lançamento acontecer → Sistema fica em estado conhecido. Mas perde registro de 'tentou sair, foi cancelado, saiu de novo'.  ·  (B) Deixar como 'cancelado' mas registrar explicitamente que saída foi revertida → Trilha fica clara, mas operador pode ficar confuso com status.
- **Recomendação:** Antes de qualquer conserto: conferir no código se sobra alguma marca interna inconsistente depois do estorno. Se não sobrar (o que parece ser o caso), fechar este item como 'não é bug'. Não reabrir o pedido pra 'aguardando saída' — esse status nem existe.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/[id]/estornar/route.ts

## P010 — Um item é marcado por 2 operadores ao mesmo tempo
- [ ] **vou fazer** · gravidade: grave · tema: Estoque apartado pros pedidos (reservas) · fluxo: Painel de Separação de Pedidos
- **Imagina assim:** Operador A e Operador B estão separando o mesmo pedido. Ambos clicam no checkbox do mesmo item no mesmo instante → o estoque sai 2 vezes de uma prateleira?
- **Hoje:** O sistema usa um travamento (lock pessimista) na prateleira para evitar isso. Quando o primeiro operador clica, o sistema trava a prateleira. O segundo clique falha com 'saldo insuficiente' OU (se for muito rápido) acaba separando de uma prateleira diferente.
- **Por que importa:** Se sair 2 vezes, o estoque saldo fica errado. Na próxima reposição, o galpão vai ficar desorientado: 'mas a gente já contou essas peças'.
- **Opções:** (A) Fazer um teste simulando 2 operadores clicando no mesmo item simultaneamente → Se passar, o sistema está seguro. Se falhar, há um buraco na segurança que causa perda de estoque.  ·  (B) Adicionar alarme/log: se um operador tenta marcar item já marcado, registrar e avisar → Mais visibilidade sobre tentativas de dupla marcação — ajuda a rastrear erros.
- **Recomendação:** Faça o teste de carga urgentemente. Se o sistema for vulnerável aqui, podem perder estoque silenciosamente em picos de separação. Uma vez testado e confirmado seguro, documente para o time confiar no sistema.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reservas-picking.ts:177-187, ledger.ts:114-179

## P011 — Item com quantidade zero bloqueia o pedido na separação
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Iniciar a separação de pedidos
- **Imagina assim:** Pedido com um item que tem quantidade zero (pode acontecer se cancelarem parte do pedido manualmente ou por erro de entrada).
- **Hoje:** O sistema consolida os itens e o item com quantidade zero some da lista. O operador não consegue marcar esse item como separado porque ele não aparece. A separação fica travada e não consegue ser concluída.
- **Por que importa:** A onda de picking fica presa. O operador não consegue avançar e o pedido não sai da bancada de separação.
- **Opções:** (A) Bloquear na entrada: o sistema recusa iniciar a separação se encontrar um item com qty=0 → Operador precisa resolver a quantidade zero antes de começar. Mais bloqueios na entrada, menos problemas depois.  ·  (B) Permitir entrar, mas ignorar no checklist: item com qty=0 não precisa ser marcado como separado → Operador consegue terminar a separação mesmo com o item fantasma. Menos bloqueios, mas pode gerar confusão sobre quais itens realmente foram separados.
- **Recomendação:** Bloquear na entrada. Se o item tem quantidade zero, algo já deu errado (cancelamento ou erro de entrada). Deixar claro pra operador consertar isso ANTES de iniciar picking.
- **➡️ MINHA ESCOLHA:** 
- **Código:** rpc 20260529_consolidar

## P012 — Confirmação falha após pedido já estar marcado como em separação
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Iniciar a separação de pedidos
- **Imagina assim:** Sistema começa a processar uma onda de separação. Marca os pedidos como 'em separação' no registro de movimentações. Aí tenta fazer uma consolidação dos itens e falha (banco lento, timeout, erro na query).
- **Hoje:** O pedido já foi marcado como 'em separação' no registro, mas a consolidação falhou. Operador vê erro na tela, reconecta ou tenta novamente. Na segunda tentativa, o sistema vê que o pedido já está 'em separação' e não faz nada. A consolidação também falha de novo. O pedido fica órfão, congelado naquele estado. Só um admin consegue descongelar manualmente.
- **Por que importa:** Pedido fica travado indefinidamente. Operador fica confuso, cliente não recebe, tempo passa.
- **Opções:** (A) Fazer a consolidação ANTES de marcar como 'em separação': se falhar, nada de estado muda → Operador tenta novamente, entra limpo da segunda vez. Sem pedidos órfãos.  ·  (B) Manter a ordem atual mas proteger com tudo-ou-nada: tudo junto ou nada → Se algo falhar, o registro desfaz automaticamente. Nenhum pedido fica meio caminho.
- **Recomendação:** Fazer a consolidação ANTES de mudar o estado. Mais simples e remove o risco de pedidos congelados.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:141-182

## P013 — Operador marca item, rede cai, e item fica travado
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Operador está separando pedido #123. Marca que pegou 5 unidades do produto X. O sistema diminui o estoque na conta, mas nesse exato momento a rede cai antes de registrar que o item foi marcado.
- **Hoje:** No painel de separação, o item continua aparecendo como não marcado mesmo que o estoque já tenha saído. Se o operador tenta marcar de novo, o sistema reclama que não consegue fazer porque o estoque já foi retirado uma vez.
- **Por que importa:** O operador não sabe se deve tentar marcar de novo ou deixar quieto. Fica confuso. O item fica pendente e atrasa a separação do pedido todo.
- **Opções:** (A) Quando a rede voltar, o sistema recarrega a tela e mostra o estado real (marcado ou não) → Operador vê que o item já foi marcado e continua; sem confusão  ·  (B) O sistema aguarda confirmação antes de diminuir o estoque, pra só fazer quando tiver certeza que gravou → Mais lento, mas garante que não sobra pedaço no meio do caminho
- **Recomendação:** A opção 1 é mais prática. Quando operador reconecta, mostre o estado real. O sistema já rastreia tudo no histórico — só precisa conferir se o estoque saiu ou não.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:141-231

## P014 — Operador tenta desmarcar um item e o sistema trava
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Operador marcou 5 unidades do produto X. Depois tenta clicar em desmarcar para refazer. O sistema tenta devolver o estoque ao monte, mas algo dá errado — talvez a prateleira esteja com problema.
- **Hoje:** O sistema registra o erro, mas não desfaz o que tinha começado. O item continua marcado (aparentando que foi pegado), mas o estoque não está devolvido. Operador tenta desmarcar de novo — e vê o mesmo erro.
- **Por que importa:** O item fica congelado. Impossível marcar e impossível desmarcar. Operador não consegue resolver sozinho e precisa chamar supervisor.
- **Opções:** (A) Envolver todo o desfazimento em uma operação tudo-ou-nada (ou tudo desfaz, ou nada desfaz) → Ou item volta limpo, ou fica marcado intacto — sem estado meia-boca  ·  (B) Tentar de novo automaticamente, com pausa entre as tentativas → Pode resolver erros de comunicação temporários; se não resolver, escala para supervisor  ·  (C) Marcar como requer supervisão e criar aviso pro gerente → Operador para e supervisor resolve manualmente
- **Recomendação:** Combine opções 1 e 3: primeiro tente envolver tudo em uma operação. Se falhar, marque como requer supervisão pra não deixar operador em loop.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:258-332

## P015 — Tentativa de desmarcar item de separação antiga falha por mudanças de estoque no meio-tempo
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Pedido #456 marcou 10 unidades do produto Y há 3 dias. Estoque saiu (saldo ficou em 50). Nesse meio-tempo, chegou compra do fornecedor — saldo agora é 60. Operador tenta desmarcar o item hoje.
- **Hoje:** O sistema tenta reverter a saída de 3 dias atrás. Mas usa os números de estoque de HOJE (60), não de 3 dias atrás. Quando tenta fazer as contas, dá inconsistência. O sistema reclama e não deixa desmarcar.
- **Por que importa:** Operador quer refazer a separação, mas o sistema não deixa porque mudou muita coisa. Separação de dias atrás fica presa.
- **Opções:** (A) Guardar o número exato de estoque do dia em que marcou, e usar esse número pra calcular a volta → Pode desmarcar qualquer hora, independente de quanto chegou depois  ·  (B) Bloquear desmarque de itens velhos (só deixa desmarcar se foi hoje) → Simples, mas operador fica preso se precisa refazer uma separação antiga
- **Recomendação:** A opção 1. O sistema já registra o número exato no histórico — só precisa usar esse número pra voltar, não o número de hoje.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/ledger.ts:44-62, src/app/api/wms/separacao/marcar-item/route.ts:258-293

## P016 — Pedido sem empresa ou galpão definido — operador não consegue marcar nada
- [ ] **vou fazer** · gravidade: grave · tema: Para onde o pedido vai (roteamento e galpão) · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Pedido #789 chegou da loja, mas alguma coisa saiu errada na integração e o pedido não tem empresa responsável ou galpão de separação definido.
- **Hoje:** Operador abre o checklist pra separar. Tenta marcar qualquer item. Sistema nega: não conseguimos dar baixa no estoque porque faltam informações desse pedido. Operador fica preso.
- **Por que importa:** Pedido não sai da separação. Operador não consegue resolver sozinho — precisa de supervisor.
- **Opções:** (A) Validar antes (quando o pedido entra no sistema). Não deixa ir pra separação se faltam dados. → Problema aparece cedo, supervisor ajusta no começo; operador nunca vê a confusão  ·  (B) Manter a validação agora (na separação), mas com mensagem mais clara que diga ao supervisor o que está faltando → Operador entende que precisa escalar, mas supervisor recebe aviso detalhado
- **Recomendação:** A opção 1. Valide antes que o pedido entre em separação. Operador nunca toca em pedido incompleto.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:94-100

## P017 — Operador digita zero na quantidade e o sistema passa
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Separação de pedidos em prateleiras (quando não tem quantidade completa)
- **Imagina assim:** Cenário 1
- **Hoje:** Quando o operador marca uma quantidade de 0 itens pegados de uma prateleira, o sistema aceita sem reclamar. Se a prateleira já estava vazia, ele cria um ajuste de estoque desaparecido, mesmo sem nada ter saído.
- **Por que importa:** Um operador clicando no botão errado ou começando a digitar sem querer acaba registrando saída de estoque que nunca aconteceu. Produto some da contagem.
- **Opções:** (A) Permitir zero somente quando o operador marca que a prateleira está vazia (checagem especial) → Fica mais seguro porque zero só passa com confirmação extra. Mas fica com um clique a mais.  ·  (B) Nunca permitir zero. Operador que achou prateleira vazia marca 'zerada' no mesmo clique → Mais rápido, zero ambiguidade. Operador não digita número, marca situação direto.
- **Recomendação:** Escolha a opção 2. Simples: operador clica no botão, vê que a prateleira está vazia, marca 'zerada' ali mesmo. Sem campo de quantidade no meio do caminho.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Separação de pedidos em prateleiras (quando não tem quantidade completa)")

## P018 — Operador clica duas vezes no mesmo botão por acaso
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Separação de pedidos em prateleiras (quando não tem quantidade completa)
- **Imagina assim:** Cenário 2
- **Hoje:** Quando o operador clica duas vezes muito rápido no botão 'Parcial' (por acaso ou porque o celular travou um segundo), às vezes o sistema já detém a primeira clicada e devolve erro 409. MAS se a segunda clicada chegar um pouco depois, o sistema não vê que já processou, e a quantidade que o operador digitou acaba sendo contada duas vezes no mesmo item. O estoque sai duas vezes.
- **Por que importa:** Se um operador pega 3 unidades mas clica duas vezes, pode sair 6 da contagem. Você vende para dois clientes da mesma coisa que não existe.
- **Opções:** (A) Criar um ID único para cada clique (token) e rejeitar qualquer segundo clique com o mesmo token → À prova de clique duplo. Operador clica 10 vezes, sistema só conta uma. Mais seguro.  ·  (B) Desabilitar o botão por 2 segundos depois do primeiro clique → Simples de entender. Operador vê o botão cinzento. Mas não funciona se o celular travou e a resposta demorou.
- **Recomendação:** Escolha a opção 1. Botão com token. Operador nunca mais vê duplicação por clique acidental.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Separação de pedidos em prateleiras (quando não tem quantidade completa)")

## P019 — Operador marca item, internet cai no meio, estoque some mas item não marcado
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Separação de pedidos em prateleiras (quando não tem quantidade completa)
- **Imagina assim:** Cenário 3
- **Hoje:** Quando o operador marca um item separado (clica Parcial), o sistema cria o registro de saída de estoque. MAS se a internet cai no meio do processo (antes de devolver o apartado do pedido pro estoque), o estoque sai, mas o sistema não consegue avisar que aquele apartado foi liberado. Fica órfão. O item nunca fica marcado como separado, mas o estoque já saiu.
- **Por que importa:** O pedido fica pendurado (aparenta incompleto) porque o sistema acha que ainda precisa de itens. Mas o estoque sumiu da contagem. Seu inventário fica desconectado da separação.
- **Opções:** (A) Usar transação (tudo-ou-nada): se internet cair, o estoque volta automaticamente → Fica perfeito. Falha? Recomeça do zero, sem órfãos. Leva um pouco mais de tempo por causa da segurança.  ·  (B) Criar um 'desfazer automático' de fundo: sistema varre órfãos a cada 5min e devolve o estoque → Estoque é recuperado, mas pode levar até 5 minutos. Nesse meio tempo está errado.
- **Recomendação:** Escolha a opção 1. Transação. O tempo extra é invisível e vale a pena por ser à prova de falhas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Separação de pedidos em prateleiras (quando não tem quantidade completa)")

## P020 — Quantidade errada quando cancela o mesmo item escaneado duas vezes
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Desfazer ou voltar etapas da separação
- **Imagina assim:** PED-005: pedido com 2 unidades do mesmo produto. Operador escaneia 2 vezes por engano, sistema marca 3 unidades bipadas. Clica Desfazer 1 vez.
- **Hoje:** Quantidade voltaria para 2 conforme esperado. MAS o sistema ja tinha baixado o estoque (lançamento após nota fiscal). O desfazer não recoloca o estoque no saldo — fica zerado.
- **Por que importa:** O produto existe fisicamente na embalagem (3 unidades), mas o sistema acha que não tem nada em estoque. Se outro pedido chegar, o sistema oferecerá como disponível um produto que está fisicamente bloqueado em outro lugar. Quando auditar depois, encontrará a conta errada.
- **Opções:** (A) Desfazer também reverte a baixa de estoque (volta o saldo para quanto era antes) → Estoque sempre consistente. Mas a auditoria fica mais complexa — haver que rastrear quando estoque voltou.  ·  (B) Desfazer só volta a quantidade no pedido, nao toca estoque (deixa zerado) → Auditoria simples. Mas operador tem que chamar supervisor pra estoque bater. Operador nao consegue corrigir sozinho.  ·  (C) Sistema avisa antes que estoque ja foi baixado, nao deixa desfazer (força cancelamento do pedido inteiro se errou) → Evita a confusao, força procedimento claro. Mas operador perde flexibilidade pra corrigir pequeno erro.
- **Recomendação:** Opção 1. A correção simples de quantidade não deveria deixar estoque quebrado. Se operador errou ao escanear, deve conseguir corrigir sem quebrar contabilidade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** desfazer-bip/route.ts:121-126, cutover.ts:76-94

## P021 — Dois cliques rápido no botão Desfazer fazem quantidade ficar errada
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Desfazer ou voltar etapas da separação
- **Imagina assim:** Operador clica Desfazer, quer clicar novamente mas nao espera a tela atualizar. Envia dois pedidos quase ao mesmo tempo.
- **Hoje:** Sistema permite: primeiro clique lê quantidade=3, diminui pra 2. Segundo clique tá correndo em paralelo, também lê quantidade=3 (ou 2 se o timing foi muito ruim), diminui pra 2 (ou 1). Resultado final fica 1 em vez de 2.
- **Por que importa:** Quantidade fica errada sem avisar. Pedido fica quebrado: sistema marca 1 unidade, embalagem fisicamente tem 2. Operador nao sabe; só descobre na devolução ou na auditoria.
- **Opções:** (A) Sistema trava o botão Desfazer por 2 segundos apos primeiro clique (impede duplo clique) → Operador nao consegue clicar 2x rápido. Bem direto. Mas e se conexao tá lenta e operador acha que nao funcionou?  ·  (B) Desfazer sempre diminui exatamente 1, nao importa quanto foi lido antes → Mesmo que clique 2x, o resultado é sempre o mesmo. Robusto. Mas precisa mudar como o código funciona.  ·  (C) Sistema prende o pedido durante a operação (nao deixa ninguem mexer enquanto Desfazer tá rodando) → Garante que so roda uma vez. Seguro. Mas se trava mal, pedido fica travado pra sempre.
- **Recomendação:** Opção 2. Desfazer deve diminuir sempre 1 unidade, sem precisar ler o valor anterior. Assim nem importa quantas vezes clica — resultado sempre correto.
- **➡️ MINHA ESCOLHA:** 
- **Código:** desfazer-bip/route.ts:84-104

## P022 — Item desaparece quando dois operadores mexem ao mesmo tempo (cancelamento concorrente)
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Desfazer ou voltar etapas da separação
- **Imagina assim:** Operador A está ajustando a quantidade de um item (parcialmente já separado). Operador B, em outro canto, cancela o pedido inteiro. Depois operador A tenta desfazer a alteração que fez.
- **Hoje:** Sistema procura o item pro Operador A desfazer. Não acha (foi deletado pelo cancelamento). Código presume que nao achar = nao tem nada pra estornar, então continua. Fica um registro órfão (quantidade vazia). Não emite aviso.
- **Por que importa:** Sistema não aviou que falhou. Operador A acha que funcionou. Depois, quando auditar, aparece um item "fantasma" no banco — quantidade vazia, ninguém sabe por quê. Pode confundir reconcialiação de estoque.
- **Opções:** (A) Travar o pedido enquanto alguém estiver mexendo nele (ninguém mais consegue cancelar ou alterar até primeiro operador terminar) → Protege contra confusão. Pero pode travar pedido se primeiro operador ficar idle.  ·  (B) Checar antes de desfazer se pedido ainda existe e tem a etapa correta. Se foi cancelado, avisar o operador com mensagem clara → Operador sabe o que aconteceu. Mensagem clara. Mas já perdeu tempo mexendo.  ·  (C) Impedir que cancelem pedido enquanto tem separação pendente (força recomeçar do zerado antes de cancelar) → Evita a sobreposição. Bem claro. Mas inflexível.
- **Recomendação:** Opção 2. Sempre checar se o item ainda existe antes de desfazer. Se não, avisar operador claro que pedido foi cancelado por outro. Nunca deixar silencioso.
- **➡️ MINHA ESCOLHA:** 
- **Código:** desfazer-parcial/route.ts:36-52

## P023 — Servidor cai no meio da reversão de estoque, fica inconsistente
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Desfazer ou voltar etapas da separação
- **Imagina assim:** Operador desfaz o pedido pra corrigir erro. Sistema começa a reverter a baixa de estoque (estorna 3 movimentos). No meio, servidor cai (internet cortou, servidor crashou).
- **Hoje:** Dos 5 movimentos que precisava estornar, só conseguiu estornar 3. O resto ficou lá. Sistema não termina de recriar a reserva e não marca a flag falsa (a marca de estoque já baixado fica verdadeira quando deveria ser falsa). Saldo volta parcialmente.
- **Por que importa:** Estoque fica num estado quebrado: faltam 2 movimentos pra contabilidade bater. Quando operador tenta avançar o pedido de novo, sistema não roda porque acha que estoque já foi lançado. Pedido tranca. Só supervisor consegue consertar manual.
- **Opções:** (A) Fazer tudo de uma vez em uma transação tudo-ou-nada. Se cai no meio, volta pro estado anterior. → Estoque sempre coerente. Seguro. Mas é complexo implementar com banco de dados distribuído.  ·  (B) Permitir reverso parcial, mas marcar pedido como 'aguardando revisão' (operador ou supervisor retoma depois) → Tolera falha, mas força ação manual. Claro qual é o trabalho pendente. Operador sabe que nao é seguro prosseguir.  ·  (C) Tentar automaticamente de novo a cada 5 minutos até conseguir completo (com limite de tentativas) → Sem intervenção manual se conexao volta logo. Mas se o erro é permanente, fica tentando e gerando noise.
- **Recomendação:** Opção 2. Marcar pedido como 'aguardando ajuste de estoque' se reverso falha no meio. Supervisores sabem exatamente o que fazer. Não deixa trava silenciosa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** cutover.ts:286-375, desfazer-bip/route.ts:175-185

## P024 — Dados corruptos impedem devolução do estoque
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Cancelamento de Separação
- **Imagina assim:** Um item na separação fica com uma referência inválida. Operador clica em Cancelar.
- **Hoje:** Sistema tenta devolver o estoque, procura o registro, não encontra e ignora. Continua o cancelamento como se estivesse ok. Estoque daquele item nunca volta.
- **Por que importa:** Estoque fica desaparecido. Vendedor vê quantidade errada. Pode prometer ao cliente o que não tem.
- **Opções:** (A) Continuar ignorando o erro → Estoque se perde silenciosamente  ·  (B) Parar o cancelamento, mostrar erro, exigir que admin corrija → Nada se perde; precisa investigação manual
- **Recomendação:** Escolha a Opção 2. Se dado está corrompido, precisa investigação. Não tente esconder.
- **➡️ MINHA ESCOLHA:** 
- **Código:** cancelar/route.ts:83-90

## P025 — Sistema aceita quantidade zero no formulário de embalagem
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Embalagem de pedidos e impressão de etiqueta
- **Imagina assim:** Um operador consegue burlar o formulário (ou usar uma ferramenta para contornar o navegador) e enviar uma quantidade igual a zero ou negativa ao fazer a embalagem.
- **Hoje:** O navegador força quantidade >= 1, mas o servidor aceita sem reclamar. Se alguém enviar -1 ou 0 direto, o sistema não falha: apenas não muda nada (no caso de zero) ou até diminui a quantidade (no caso de negativo).
- **Por que importa:** Abre brecha de segurança. Alguém externo consegue manipular dados da embalagem sem o sistema avisar que algo está errado. O saldo fica inconsistente e ninguém fica sabendo.
- **Opções:** (A) Adicionar validação no servidor: se quantidade <= 0, devolve erro 400 → Formulário fica seguro. Qualquer tentativa de contorno falha com mensagem clara.  ·  (B) Deixar como está (apenas a tela valida) → Continua vulnerável a ataques diretos. Risco cresce se a comunicação entre sistemas tiver acesso público.
- **Recomendação:** Faça a validação no servidor. Demora 30 minutos, impede bypass futuro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** page.tsx:40-42; RPC linha 86

## P026 — Dois cliques no mesmo instante expedem o pedido duas vezes
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Marcar pedido como enviado
- **Imagina assim:** Expedição de pedidos prontos para envio
- **Hoje:** O operador clica em 'Enviar' duas vezes rapidinho (ou o sistema recebe duas solicitações ao mesmo tempo). A primeira muda o pedido de 'pronto pra enviar' para 'enviado'. A segunda clique também retorna sucesso, mas não faz nada — o pedido já estava 'enviado'. O operador não sabe que o segundo clique não funcionou, só vê dois sucessos.
- **Por que importa:** O pedido já saiu na primeira vez. Se o operador acha que enviou duas vezes, ele pode reenviar para o mesmo cliente (e pagar frete de novo, ou gerar confusão no rastreamento). A gente não registra que falhou, então fica silencioso.
- **Opções:** (A) Desabilitar botão de envio enquanto a primeira requisição tá processando → Operador só consegue clicar uma vez; segundo clique não sai pro servidor  ·  (B) Devolver erro se tentarem enviar um pedido que já está 'enviado' → Segundo clique avisa: 'Esse pedido já foi enviado', operador sabe que falhou
- **Recomendação:** Desabilitar botão enquanto processa (mais rápido e evita confusão). Se alguém conseguir mandar dois ao mesmo tempo (improvável), devolver erro pro operador ver.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:115-155

## P027 — Admin não consegue voltar um pedido já enviado
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Marcar pedido como enviado
- **Imagina assim:** Um pedido foi marcado como enviado, mas depois a loja pede pra cancelar ou ajustar algo
- **Hoje:** Admin tenta mover o pedido de 'enviado' de volta para 'pronto pra enviar' (desfazer a expedição), mas o sistema não deixa. A lista de etapas aceitas só tem 'separado', 'embalado' — não inclui 'enviado'. Operador ou admin fica preso, não consegue desfazer.
- **Por que importa:** Às vezes precisa voltar (cliente quer cancelar depois que marcamos como enviado, ou marcamos errado). Sem isso, admin tem que mexer direto no banco de dados ou ligar pra TI.
- **Opções:** (A) Adicionar 'enviado' na lista de etapas reversiveis → Admin consegue clicar 'Voltar' de um pedido enviado e ele volta pra 'pronto pra enviar'  ·  (B) Deixar como tá (sem reverter enviado) → Admin continua sem poder desfazer; tem que contornar manualmente
- **Recomendação:** Incluir 'enviado' agora mesmo. Não custa nada e desbloqueia um caso que acontece.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/cutover.ts:21-29

## P028 — A entrada de mercadoria não grava completa no histórico do estoque
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Gestão de compras de fornecedor
- **Imagina assim:** Um fornecedor manda 50 unidades de um produto. O operador clica em 'Confirmar recebimento'. O sistema registra que chegaram 50 peças (o saldo fica correto), MAS o histórico fica incompleto. Tipo assim: você marca 50 litros de leite que chegaram, o leite entra no estoque, MAS no livro de histórico está faltando o registro dessa entrada.
- **Hoje:** O sistema tenta registrar a entrada em dois lugares ao mesmo tempo: (1) atualiza a quantidade em banco de dados, (2) tenta gravar no histórico. Se o histórico falha (prateleira não existe, produto não foi encontrado, ou o sistema travar enquanto escreve), só acontece (1). O sistema marca um aviso no painel pra investigar depois, mas continua como se tudo estivesse OK. O operador não sabe que faltou história. Próximas operações podem liberar o pedido sem que o histórico esteja certo.
- **Por que importa:** Se uma auditoria ou inventário manual acontecer, a contagem não bate com o sistema. Não dá pra saber quando aquela mercadoria entrou de verdade. E se você tiver que devolver coisas, fica confuso qual entrada era qual.
- **Opções:** (A) Tudo-ou-nada (trancado): se o histórico falhar, a entrada toda volta atrás — operador tenta novamente. Seguro, mas operador precisa ficar de olho. → Sem risco de desencontro. Mas o operador pode se incomodar se algo sempre falha.  ·  (B) Tentar histórico primeiro, depois atualizar: inverte a ordem. Se histórico falhar, não atualiza a quantidade. Mesma segurança, outra ordem. → Mesmo efeito: tudo-ou-nada.  ·  (C) Deixa como está (melhorar só o aviso): sistema marca alertas mais claros. Precisa de alguém monitorando os avisos regularmente. → Mais rápido de entrar, mas alguém tem que ficar checando alertas todo dia.
- **Recomendação:** Escolha 'tudo-ou-nada' — o custo de ficar de olho é menor do que descobrir, meses depois, que o estoque não bate na auditoria. Adicione uma tela que lista todas as entradas com problema, e o operador clica pra tentar de novo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Gestão de compras de fornecedor")

## P029 — Operador digita a prateleira errada ao confirmar que encontrou a mercadoria
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Validação do estoque quando precisa de compra
- **Imagina assim:** Um pedido de compra chega com 5 unidades do produto XYZ. Operador marca que encontrou, mas digita ou scanneia a prateleira errada (por exemplo: digita LOC-A quando o produto está na LOC-B).
- **Hoje:** O sistema registra a mercadoria na prateleira errada. Depois, quando um outro pedido tenta pegar essa mercadoria para enviar pro cliente, o sistema procura na LOC-A (onde o operador digitou). Se tem outro produto na LOC-A, o sistema pega errado. Se não tem nada, o operador vê uma mensagem de erro e o item fica pendente.
- **Por que importa:** A mercadoria fica registrada em lugar diferente de onde ela realmente está no galpão. Isso causa atraso (operador não acha o produto) ou risco de enviar produto errado pro cliente.
- **Opções:** (A) Operador escaneia TANTO o código da prateleira QUANTO o código de barras do produto antes de confirmar → Sistema verifica se produto + prateleira conferem. Rejeita se não bater. Demora mais 5 segundos por item, mas elimina erro.  ·  (B) Sistema registra a prateleira, mas mais tarde faz uma conferência (um operador vai lá ver se está mesmo) → Erros descobertos depois, com atraso. Operador ainda precisa corrigir manualmente.  ·  (C) Deixar como está agora (sem validação) → Continua acontecendo erros. Cliente recebe produto errado ou entrega atrasa.
- **Recomendação:** Implante validação de código de barras do produto (confirma que item está realmente na prateleira digitada) antes de o operador marcar 'encontrei'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:170-200

## P030 — Dois operadores clicam 'encontrei' no mesmo produto ao mesmo tempo
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Validação do estoque quando precisa de compra
- **Imagina assim:** Pedido de compra tem 5 unidades de caneta azul (SKU-123). Operador A e operador B estão conferindo lado a lado (conexão lenta ou acidente). Ambos veem o item como não confirmado e clicam 'encontrei' quase simultaneamente.
- **Hoje:** Operador A clica, carrega o item (5 unidades, nenhum registro de quem pegou). Operador B clica no mesmo segundo, também carrega o item (5 unidades, sem saber que A já pegou). Ambos confirmam. O sistema registra 2 movimentações de saída (uma para A, uma para B). O saldo total desce 10 unidades (5+5), mas o sistema só marca que o item foi pego uma vez. Matemática errada.
- **Por que importa:** Estoque fica errado. O sistema acha que tem menos mercadoria do que realmente tem. Pode causar cancelamento de vendas 'sem estoque' ou devoluções erradas depois.
- **Opções:** (A) Ao começar a processar o item, sistema trava pra só um operador mexer → Segundo operador recebe aviso 'operador X já está processando este item'. Precisa esperar. Sem risco de duplicação.  ·  (B) Ao confirmar, sistema valida se ninguém mexeu no item no meio-tempo → Se detectar mudança, pede pro operador carregar de novo. Mais lento, mas seguro.  ·  (C) Deixar como agora → Cliques simultâneos continuam dobrando a contagem de mercadoria
- **Recomendação:** Implante um trava quando operador começa a processar um item. Segundo operador vê que o item já está em processamento e espera a vez.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:66-84, route.ts:390-403

## P031 — OC de outro galpão — decisão final está errada quando há mistura
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Conclusão de pedido de compra após recebimento completo
- **Imagina assim:** Um pedido chega pro galpão A, mas os produtos são de uma compra que vem do galpão B (e talvez C também). O sistema precisa decidir se é transferência ou não.
- **Hoje:** O sistema pega só a primeira compra que encontra (galpão B). Se tem 2 itens de galpão B e 1 item de galpão C, marca como transferência pro B e ignora silenciosamente o C. Não reclama, não avisa.
- **Por que importa:** O pedido pode sair pra galpão errado. Se o item que vem de C ficar em A, vai aparecer sobrando em um lugar e faltando em outro.
- **Opções:** (A) Bloquear: Se tem itens de galpões diferentes, mostra aviso vermelho 'Este pedido tem compras de 2 galpões. Não pode concluir assim.' e o operador separa manualmente. → Mais seguro, mas mais cliques. Operador tem que rejeitar tudo e re-fazer em 2 vezes.  ·  (B) Automatizar: Sistema divide sozinho — cria 2 'grupos de transferência', um pro galpão B e outro pro C, e envia em paralelo. → Mais rápido, mas complexo de implementar e monitorar se saiu tudo certo pra cada lugar.
- **Recomendação:** Bloquear agora (mostrar aviso), depois pensar em automação se virar comum. Mais seguro pra não mandar coisa pra lugar errado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** /concluir-oc/route.ts:241-260

## P032 — Recebimento fica preso quando produto não está cadastrado
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Recebimento de compras de fornecedor com conferência
- **Imagina assim:** Operador confere 10 unidades de um item de compra, clica em confirmar, mas o sistema falha porque a prateleira de recebimento não existe ou o produto não está cadastrado
- **Hoje:** O sistema tenta gravar o recebimento mas bate uma error. Marca o pedido com um aviso. As 10 unidades NÃO ficam registradas no sistema. O pedido fica travado e não avança. O operador vê o aviso na tela de compras.
- **Por que importa:** O saldo nunca é atualizado. A mercadoria chegou de verdade, mas o sistema não sabe disso. Qualquer pessoa que consultar a quantidade disponível vai ver que ainda falta comprar.
- **Opções:** (A) Deixar tentando: operador tenta novamente quando o cadastro estiver pronto → A mercadoria fica parada no galpão. Demora pra contar no sistema.  ·  (B) Guardar as 10 unidades numa caixa de 'em dúvida' e depois que tudo estiver certo, colocar na prateleira e registrar → Mercadoria não some, mas aparece em um lugar estranho na contagem. Precisa de um ajuste depois.  ·  (C) Deixar registrado que tentou mas falhou, pra o gerente saber que aquelas 10 unidades estão lá e precisam de ajuste manual → Ninguém esquece, mas o sistema fica desalinhado. Inventário bate depois de um ajuste manual.
- **Recomendação:** Coloca um 'estacionamento' automático pro recebimento que falhou: as 10 unidades ficar num local marcado como 'em recebimento com erro', e manda um aviso pro gerente. Quando o cadastro resolver, ele clica pra liberar de verdade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:223-266

## P033 — Recebimento com brinde fica errado: operador confere 12 mas sistema registra só 10
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Recebimento de compras de fornecedor com conferência
- **Imagina assim:** Compra pedia 10 unidades. Fornecedor manda 12 (brinde de 2 unidades). Operador confere 12 na caixa, escreve no motivo 'Brinde fornecedor', e submete
- **Hoje:** O sistema vê que pediu 10 e só registra 10. As 2 de brinde desaparecem do registro — não contam pra nada. O motivo do brinde fica escrito num campo, mas não gera um recebimento extra pra aquelas 2 unidades.
- **Por que importa:** Se o operador errou e na verdade só tinha 10, ninguém descobre. Se realmente tinha 12 e era brinde, o saldo fica errado: o sistema diz que tem 10, mas na prateleira tem 12.
- **Opções:** (A) Ignorar e deixar como está: o operador tira as 2 unidades da prateleira e bota num lugar diferente → Saldo fica desalinhado do que realmente tem no galpão. Depois tem que fazer inventário manual pra acertar.  ·  (B) Registrar como recebimento em duas etapas: primeiro as 10 solicitadas, depois submete novamente com +2 de brinde → Tudo fica correto e rastreado. Mas o operador precisa fazer duas ações pra uma caixa só.  ·  (C) Deixar receber qualquer quantidade e registrar o excesso como 'ganho de inventário' automaticamente → Tudo fica fácil pro operador. O sistema acompanha melhor. Depois tem um ajuste contábil pro ganho.
- **Recomendação:** Quando o operador digita uma quantidade maior que o pedido, o sistema deve avisar 'Você está recebendo 12 mas o pedido era 10. A mais vai contar como ganho'. Se ele confirma, registra 10 como recebimento normal e 2 como ganho de inventário. Fica tudo rastreado e o saldo certo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:79-134, route.ts:283-295

## P034 — Operador cancela a compra do fornecedor, mas o estoque apartado nunca é devolvido
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Criar compra automática quando um pedido chega sem estoque
- **Imagina assim:** Dia 1: Sistema cria uma compra de 5 peças (porque tem só 1 na prateleira). Dia 2: Operador aprova a compra. Dia 3: Operador muda de ideia e clica em 'Recusar' o pedido.
- **Hoje:** O sistema marca o pedido como cancelado. Mas não devolve o estoque apartado — a reserva continua bloqueando aquela quantidade. Depois de 30 dias, a reserva morre sozinha e o estoque fica livre novamente.
- **Por que importa:** Naqueles 30 dias, você acha que tem menos estoque disponível do que realmente tem. Se outro pedido entra, o sistema recusa porque vê as peças como 'apartadas e bloqueadas'. Você pensa que falta estoque quando na verdade o estoque está lá, só que preso.
- **Opções:** (A) Devolver automático: quando cancela, libera a reserva na mesma hora → Saldo fica certo. Outros pedidos podem usar essas peças. Leva 2-3 horas pra corrigir.  ·  (B) Devolver manual: operador clica um botão de 'desfazer aparte' depois de cancelar → Dá controle (às vezes você quer deixar bloqueado por motivo), mas depende do operador lembrar. Risco de deixar parado.
- **Recomendação:** Automático. Quando operador recusa a compra, libera na mesma hora. Se amanhã ele quer rebloquear, reconstrói o aparte manual.
- **➡️ MINHA ESCOLHA:** 
- **Código:** pedidos/aprovar/route.ts:64-98 (rejeitar block sem cleanup)

## P035 — Pedido fica 'dormindo' para sempre depois que a compra é cancelada
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Criar compra automática quando um pedido chega sem estoque
- **Imagina assim:** Dia 1: Sistema cria compra de 5 peças que faltam. Pedido entra no status de 'esperando a compra chegar'. Dia 7: Operador cancela aquela compra (não vem do fornecedor). Dia 30: Estoque das 5 peças entra por outro caminho (ex.: compra emergencial com outro fornecedor).
- **Hoje:** Quando o estoque chega no dia 30, o sistema tenta reconciliar (conectar o estoque ao pedido). Mas não consegue, porque o pedido está em status 'esperando compra cancelada' e o sistema não consegue voltar atrás. O pedido fica travado, o estoque fica lá, preso.
- **Por que importa:** Você tem as peças na prateleira. O pedido precisa daquelas peças. Mas os dois nunca se encontram. O pedido não avança, o cliente não recebe.
- **Opções:** (A) Voltar pedido para 'pendente' (começo da fila) → Sistema tenta denovo buscar saldo. Se chegou, aprova automático. Se não chegou, permite novo ciclo de compra. Limpo.  ·  (B) Deixar operador decidir manualmente cada vez → Mais controle, mas operador precisa ficar de olho. Risco de esquecer pedido parado.
- **Recomendação:** Voltar para 'pendente'. Operador cancela a compra e o sistema trata como se fosse novo, buscando saldo ou criando nova compra.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reconciliador-oc.ts:37-39 (STATUS_PEDIDO_OC filter), compras-utils.ts:178-234

## P036 — Trocar SKU após marcar comprado (já na compra)
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Trocar um produto em uma compra (antes de fazer a encomenda)
- **Imagina assim:** Item foi marcado como 'comprado' e já tem número de compra. Operador volta e tenta trocar o SKU por outro.
- **Hoje:** O sistema não verifica se a compra já foi efetuada. Permite a troca mesmo assim. Resultado: o número da compra no fornecedor mostra um SKU, mas no seu pedido aparece outro diferente. Quando a mercadoria chega, o sistema procura pelo SKU novo, mas o comprovante da compra tem o SKU antigo. Fica um caos de documentação.
- **Por que importa:** Quando chega a mercadoria, precisa bater com o comprovante de compra. Se não bate, o recebimento quebra. Além disso, perdem o histórico de qual SKU foi de fato comprado.
- **Opções:** (A) Impedir a troca automaticamente → Operador tenta trocar, sistema mostra mensagem 'essa compra já foi marcada, não pode trocar mais'. Ele precisa cancelar a compra anterior e criar uma nova se realmente precisa mudar.  ·  (B) Avisar mas deixar trocar → Sistema permite mas mostra aviso: 'cuidado, isso vai quebrar a compra aberta'. Operador assume o risco mas fica o problema.
- **Recomendação:** Fazer o sistema bloquear. Não custa nada — é só validar o status antes de deixar trocar. Evita horas de confusão no recebimento depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:186-199

## P037 — Mudança de SKU é registrada mas histórico falha e fica sem anotação
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Trocar um produto em uma compra (antes de fazer a encomenda)
- **Imagina assim:** Operador muda o SKU. O sistema atualiza o pedido, mas na hora de registrar no histórico acontece um erro (lentidão do banco, timeout). O pedido foi alterado mas o histórico fica vazio.
- **Hoje:** O dado é mudado no banco. Depois o sistema tenta registrar a mudança no histórico — se isso falha, lança erro. O operador vê 'erro ao salvar'. Mas o dado já estava gravado antes do erro. Próxima vez que tenta, a lógica confunde porque o dado já mudou. Auditoria fica sem registro do que aconteceu e quem fez.
- **Por que importa:** Sem histórico, você não consegue rastrear quem mudou o quê e quando. Se depois aparece um problema (compra errada, mercadoria divergente), você fica sem prova de quando e como aconteceu. Cria risco de compra duplicada ou perdida.
- **Opções:** (A) Fazer tudo em uma só transação (tudo ou nada) → Se histórico falha, a mudança do SKU é desfeita. Operador vê erro e tenta novamente do zero. Garante que mudança sempre tem histórico. Um pouco mais lento mas seguro.  ·  (B) Deixar falha em background e deixar operador tentar novamente → Aceita a mudança mesmo que histórico falhe. Em segundo plano, o sistema tenta registrar de novo. Mais rápido pro operador mas fica o risco de perder o registro.
- **Recomendação:** Transação. Leva poucos milissegundos a mais mas garante que nunca fica incompleto. Auditoria fica íntegra — sempre sabe o que mudou.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:186-199 e 213

## P038 — Pedido cancelado não libera o estoque apartado
- [ ] **vou fazer** · gravidade: grave · tema: Estoque apartado pros pedidos (reservas) · fluxo: Marcar uma mercadoria como indisponível (cancelamento de compra)
- **Imagina assim:** Pedido #456 com 5 unidades reservadas (apartadas no estoque) é cancelado às 14:00
- **Hoje:** As 5 unidades continuam marcadas como apartadas até 1 hora depois (quando roda a rotina automática de limpeza) OU até alguém do admin liberar manualmente. Nesse meio tempo, se outro pedido chegar e precisar dessas 5 unidades, o sistema acha que elas ainda estão comprometidas e bloqueia a venda.
- **Por que importa:** O dono pensa que tem 100 unidades disponíveis. Na realidade, 5 estão presas num pedido fantasma cancelado. Operador tenta vender as 100 e consegue só 95, criando atraso e confusão. Além disso, fica 1 hora de gap onde a gente não conta com aquelas 5 pra vender de verdade.
- **Opções:** (A) A. Corrigir o código pra liberar automaticamente no ato do cancelamento → As 5 unidades voltam pro monte de verdade na hora (às 14:00). Operador consegue vender elas pro próximo pedido sem atraso.  ·  (B) B. Deixar como está (rotina a cada 1 hora + ação manual quando urgente) → Continua o gap de até 1 hora. Operador segue tendo que fazer liberação manual às vezes.
- **Recomendação:** Opção A. Uma hora é tempo demais em estoque — estoque apartado errado significa venda perdida agora.
- **➡️ MINHA ESCOLHA:** 
- **Código:** compras-utils.ts:149-162

## P039 — Item de compra cancelado, mas estoque ainda fica bloqueado
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Cancelamento de item de compra de fornecedor
- **Imagina assim:** Pedido tem 5 itens (3 de compra, 2 da loja). Aprova o pedido. Sistema bloqueia o estoque dos 5 itens. Depois descobre que um dos itens de compra foi cancelado pelo fornecedor. Marca como cancelado no sistema.
- **Hoje:** O estoque continua aparecendo como bloqueado para esse item, como se ainda estivesse apartado pro pedido. Estoque fica preso eternamente — quantidade reservada não baixa nunca.
- **Por que importa:** Faz parecer que tem menos quantidade disponível do que realmente existe. Pode impedir venda de outras peças porque o sistema pensa que estoque está comprometido.
- **Opções:** (A) Fazer nada — operador libera manualmente (clica botão de liberar) → Depende de operador lembrar. Se esquecer, estoque fica travado pra sempre.  ·  (B) Liberar estoque automaticamente quando confirma cancelamento → Estoque volta pra quantidade disponível imediatamente, sem etapa manual.
- **Recomendação:** Liberar automaticamente. Quando alguma coisa é cancelada, estoque que estava reservado tem que voltar pro montante da loja.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts linha 51-64

## P040 — Item que já foi separado (encostado na prateleira) não pode ser cancelado direito
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Cancelamento de item de compra de fornecedor
- **Imagina assim:** Pedido de compra. Item iniciou a separação — operador já pegou 3 peças de 5. Depois descobre que quer cancelar esse item e confirma o cancelamento.
- **Hoje:** Sistema zera a quantidade que foi pegada (volta pra 0), sem deixar registro de por onde foi. Os movimentos que foram criados no início ficam órfãos, sem compensação. Auditoria fica quebrada.
- **Por que importa:** Não dá pra rastrear o que aconteceu com aquelas 3 peças que foram movidas. Estoque não bate com o que foi separado de verdade.
- **Opções:** (A) Permitir cancelamento mesmo com separação iniciada, zerando a quantidade → Perde rastreabilidade das peças que foram movidas. Auditoria fica inconsistente.  ·  (B) Bloquear cancelamento se há quantidade separada, avisando que precisa desfazer a separação antes → Obriga sequência correta: desfaz separação primeiro, depois cancela. Auditoria fica limpa.
- **Recomendação:** Bloquear cancelamento. Se tem coisa já separada, não deixa cancelar — tem que voltar a separação pra trás primeiro (igual como funciona nos pedidos de venda).
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts linha 58-60

## P041 — Compra parcial recebida, item cancelado, depois chega o resto — estoque fica invisível
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Cancelamento de item de compra de fornecedor
- **Imagina assim:** Compra tem 10 peças. Recebeu 6. Operador cancela 1 das 4 que faltavam. Depois fornecedor manda os 4 restantes que estavam pendentes.
- **Hoje:** O sistema apagou a ligação entre o item e a compra quando cancelou. Quando chega o estoque, o sistema não consegue religar e avisar que a compra parcial apareceu. Peça entra no sistema mas fica invisível, sem saber de onde veio.
- **Por que importa:** Estoque chega mas o pedido não é marcado como completo. Falha a automação que deveria avisar quando compras ficam prontas.
- **Opções:** (A) Apagar a ligação com a compra (como está agora) → Estoque que chega depois fica órfão, sem saber que é resto de uma compra incompleta.  ·  (B) Manter a ligação e criar um registro de estorno em vez de apagar → Estoque que chega depois consegue se religar e o sistema marca compra como completa automaticamente.
- **Recomendação:** Manter a ligação com a compra. Cancelamento é só negócio, não pode quebrar a rastreabilidade das peças.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/cancelamento/route.ts linha 54 e cancelamento/confirmar/route.ts linha 55

## P042 — Tenta cancelar item que já chegou 100% — sistema deixa cancelar de novo
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Cancelamento de item de compra de fornecedor
- **Imagina assim:** Compra tem 5 peças de um item. Recebeu as 5 inteiras. Operador por engano (clicou no item errado, ou problema na tela) marca pra cancelar.
- **Hoje:** Sistema permite marcar como cancelado mesmo que as 5 peças já entraram no estoque. Item aparece como cancelado mas a quantidade já foi contada. Fica confuso se aquelas 5 peças existem ou não existem.
- **Por que importa:** Se cancela estoque que já está no galpão, a contagem fica errada. Parece que as peças desapareceram quando na verdade estão lá.
- **Opções:** (A) Permitir cancelamento de tudo, sem validação → Pode cancelar por engano estoque que já está fisicamente no galpão. Contagem fica errada.  ·  (B) Bloquear cancelamento se item já recebeu quantidade. Se quer tirar, usa devolução (processo reverso) → Garante que cancelamento é só pra coisas que nunca chegaram. Estoque que chegou precisa de processo de devolução adequado.
- **Recomendação:** Bloquear. Se as peças já chegaram, não é cancelamento — é devolução, e precisa de processo diferente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/cancelamento/route.ts linha 33-44

## P043 — Devolvendo duas vezes: o segundo clique não faz nada, mas parece OK
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Devolver um item de compra de fornecedor
- **Imagina assim:** Operador clica 'Devolver item' na tela duas vezes seguidas, muito rápido, no mesmo item de compra
- **Hoje:** O primeiro clique processa e volta o item pra fila de compra. O segundo clique tenta fazer a mesma coisa, mas o item já foi mudado pelo primeiro, então não faz nada de real — mas o sistema responde 'tudo bem' pro operador mesmo assim, como se o segundo clique tivesse funcionado.
- **Por que importa:** Operador acha que fez a operação duas vezes quando só uma funcionou. Cria confusão no que foi devolvido de verdade e o que não foi.
- **Opções:** (A) Desabilitar o botão no navegador por 2 segundos após clicar → Simples de implementar. Operador não consegue clicar duas vezes.  ·  (B) Marcar cada devolução com um ID único no servidor, descartar cópias idênticas → Mais robusto. Protege contra cliques simultâneos mesmo que a rede seja lenta. Operador pode ter certeza que só uma foi processada.
- **Recomendação:** Opção 2: marcar cada devolução com ID único. Isso impede confusão mesmo se a rede travar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/devolver/route.ts:44-60

## P044 — Devolvendo item de um pedido que já saiu: estoque fica bloqueado pra nada
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Devolver um item de compra de fornecedor
- **Imagina assim:** Um pedido de cliente foi aprovado e o sistema já colocou em estoque e separou. Depois, alguém tenta devolver um item dessa compra pra fornecedor.
- **Hoje:** O sistema deixa fazer. O item volta pra 'aguardando compra'. Mas o estoque que foi separado pra vender continua marcado como 'apartado pra esse pedido'. Fica uma quantidade presa, bloqueada, que não pode ser usada pra nada.
- **Por que importa:** Perde quantidade disponível à toa. O cliente pode ter cancelado o pedido ou mudou o requisito, e você traz de volta uma coisa que não consegue vender, enquanto o seu estoque fica menor.
- **Opções:** (A) Impedir devolução se o pedido não está mais em 'pendente' → Garante que você só devolve compra pra fornecedor enquanto o pedido ainda está sendo planejado, não durante execução.  ·  (B) Permitir devolução, mas liberar automaticamente o estoque bloqueado do cliente → Operador tem flexibilidade, mas o estoque volta a ficar disponível pra vender pra outro.
- **Recomendação:** Opção 1: bloquear devolução após pedido sair de pendente. Mais seguro. Evita o caos de estoque bloqueado órfão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/devolver/route.ts:1-92

## P045 — Devolve 1 item de 3, compra fica em status estranho
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Devolver um item de compra de fornecedor
- **Imagina assim:** Uma compra tem 3 itens: 2 já chegaram do fornecedor, 1 ainda está a caminho. Operador devolve aquele que ainda está a caminho.
- **Hoje:** O sistema marca a compra como 'parcialmente recebida'. Mas a realidade é: 2 recebidos, 1 voltado pra fila de compra. O status 'parcialmente recebida' não descreve isso direito e atrapalha a lógica de reordenar ou cobrar do fornecedor.
- **Por que importa:** Status errado vira problema pra relatórios, cobrança de fornecedor e reordenação. Você não sabe se a compra está viva, morta ou pendurada.
- **Opções:** (A) Status fica 'parcialmente_recebido' se tem recebidos E tem não-recebidos → Correto logicamente. Mas precisa ter a lógica escrita e testada.  ·  (B) Status volta pra 'em compra' se nenhum item chegou; fica 'parcialmente_recebido' se alguns chegaram → Mais clara: 'em compra' quer dizer 'esperando'; 'parcialmente' quer dizer 'já veio coisa'.
- **Recomendação:** Opção 2: volta pra 'em compra' se nada chegou; fica 'parcialmente' se algo chegou. Mais fácil de entender.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/compras-utils.ts:178-234

## P046 — Estorno perdido: item que foi separado não volta ao estoque quando devolvido
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Devolver um item de compra de fornecedor
- **Imagina assim:** Um item de compra foi separado pro pedido (picking) — foi tirado da prateleira e marcado como 'saído'. Depois alguém marca como devolução.
- **Hoje:** O sistema limpa o ID do movimento de saída, mas não refaz o movimento: não devolve a quantidade pra prateleira no sistema. O saldo fica errado — o sistema acha que tem menos quantidade do que realmente tem.
- **Por que importa:** O inventário começa a ficar errado. Depois, quando você contar tudo ou fazer um reajuste, vai ter que fazer muito trabalho extra pra achar as diferenças.
- **Opções:** (A) Gravar um novo movimento (entrada) que desfaz a saída anterior, automático → Mantém histórico: fica claro que saiu e voltou. Saldo fica correto.  ·  (B) Apagar a saída e contar como se nunca tivesse saído → Mais simples. Mas perde histórico — depois não fica claro o que aconteceu.
- **Recomendação:** Opção 1: gravar estorno automático. Mantém rastreabilidade e arruma o saldo de verdade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/compras-utils.ts:27-29

## P047 — Pedido bloqueado com item solto: sistema acha que está pronto, mas não está
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Devolver um item de compra de fornecedor
- **Imagina assim:** Um pedido de cliente foi aprovado, o estoque foi separado (marcado como lançado). Depois, alguém devolve um dos itens da compra pra fornecedor.
- **Hoje:** O pedido fica marcado como 'lançado' (estoque já saiu da prateleira), mas um dos itens agora está 'aguardando compra' (desvinculado do pedido). O sistema tem um registro dizendo 'esse pedido terminou', mas na realidade tem um item faltando. Ninguém vai verificar de novo porque o sistema achou que já estava pronto.
- **Por que importa:** Pedido pode sair incompleto pro cliente, ou ficar parado porque o sistema acha que já fez a parte dele.
- **Opções:** (A) Impedir devolução se pedido já foi lançado (estoque já saiu) → Seguro. Força resolver antes de lançar.  ·  (B) Permitir, mas marcar pedido pra ser revalidado antes de sair pro cliente → Flexível. Mas requer alguém estar atento pra revalidar.
- **Recomendação:** Opção 1: impedir devolução após lançamento. Evita o risco de deixar passar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/devolver/route.ts

## P048 — Compra não atualiza se o servidor se recusa a processar
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Devolver um item de compra de fornecedor
- **Imagina assim:** Operador clica Devolver. Item volta OK. Mas na hora de atualizar o status da compra, o banco de dados está lento e não responde.
- **Hoje:** O sistema registra o erro num arquivo de log, mas ignora. O item foi devolvido, mas o status da compra não foi atualizado. Operador não vê mensagem de erro — pensa que deu tudo certo.
- **Por que importa:** Compra fica com status desatualizado. Operador não sabe que tem que tentar de novo. Depois descobre dias depois.
- **Opções:** (A) Tentar 3 vezes automaticamente antes de desistir → Resolve a maioria dos problemas de latência. Se falhar, aí mostra erro real.  ·  (B) Mostrar erro pro operador imediatamente → Operador vê logo e pode tentar de novo ou avisar TI.
- **Recomendação:** Opção 1 + Opção 2: tentar 3 vezes, e se falhar, mostrar erro pro operador. Nenhuma operação fica silenciosa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/compras-utils.ts:190-195

## P049 — Classificação de devolução incompleta (alguns passos podem não rodar)
- [ ] **vou fazer** · gravidade: grave · tema: Devoluções · fluxo: Recebimento e classificação de devoluções
- **Imagina assim:** Operador marca uma devolução como 'Classe B'. O sistema precisa fazer 3 movimentos: tirar do piso, tirar do piso de novo, guardar em quarentena.
- **Hoje:** Se o sistema falha no meio (por exemplo, quarentena não existe), apenas 1 ou 2 movimentos saem registrados. A devolução fica marcada como 'aguardando classificação' (não classifica). O histórico mostra movimentos soltos, sem devolução associada.
- **Por que importa:** Você não sabe se a devolução foi processada ou não. Se rodar novamente, pode processar 2 vezes. O saldo fica errado.
- **Opções:** (A) Tratar os 3 passos como um bloco único (ou roda tudo, ou nada) → Garante que devolução fica consistente. Se falhar, operador tenta de novo com mesma devolução.  ·  (B) Deixar como está (risco de incompleto) → Continua com risco de saldo errado e movimentos órfãos no histórico.
- **Recomendação:** Opção 1. Essa é uma falha de segurança que afeta direto o saldo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:101-335

## P050 — Saldo entra mas o pedido fica preso
- [ ] **vou fazer** · gravidade: grave · tema: Devoluções · fluxo: Recebimento de devolução de cliente e volta ao estoque
- **Imagina assim:** 1
- **Hoje:** Operador lança uma devolução: o parachoques volta pro estoque (+3 unidades no saldo). O sistema registra a movimentação no registro das movimentações de estoque (fica gravada). Mas quando tenta atualizar a etapa da devolução de 'pendente' para 'pronta', o banco de dados falha. A devolução continua marcada como 'pendente', mas o saldo já subiu. Se alguém clica pra tentar de novo, corre o risco de o parachoques ser contado duas vezes no saldo — uma da primeira tentativa, outra na segunda.
- **Por que importa:** Seu estoque no sistema não bate com o físico. Um parachoques pode ser contado em dobro e você vende o que não existe de verdade, gerando falta pra cliente.
- **Opções:** (A) Usar um 'guarda-chuva' que protege tudo junto (tudo-ou-nada) → Ou entra tudo de uma vez, ou falha tudo de uma vez. Nada fica pela metade. Mais seguro, um pouco mais lento.  ·  (B) Se falhar a etapa, desfazer a movimentação que entrou → Volta ao estado inicial. Operador tenta de novo. Mais controle, mas precisa de código pra reverter (e se isso também falhar?).  ·  (C) Deixar como está, mas avisar o operador (log vermelho) → Operador percebe o erro e pode reverter manualmente. Sem garantia — depende de quem está vendo a tela.
- **Recomendação:** Opção 1 (tudo-ou-nada). Se entra, entra completo. Se falha, volta ao zero. Sem meia-entrada. Isso previne o dobro-contagem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/devolucoes.ts:194-206, 325-334, src/lib/wms/ledger.ts:123

## P051 — Item avariado suma do galpão sem deixar rastro
- [ ] **vou fazer** · gravidade: grave · tema: Devoluções · fluxo: Recebimento de devolução de cliente e volta ao estoque
- **Imagina assim:** 2
- **Hoje:** Operador marca 2 parachoques como avariados (classe B) na prateleira A-02-15. O sistema tira os 2 da prateleira A-02-15 (−2) e tenta guardar na quarentena. Se a quarentena não existe no cadastro, o sistema silenciosamente tira de A-02-15 mas não coloca em lugar nenhum. Ninguém recebe aviso — apenas entra um log que ninguém lê. O parachoques desaparece do sistema, mas fisicamente ainda pode estar na prateleira.
- **Por que importa:** Seu estoque não bate com a realidade. O parachoques está ali, mas o sistema acha que sumiu. Quando você conta (faz inventário), aparece excesso de estoque que o sistema não registra.
- **Opções:** (A) Bloquear: se não tiver quarentena, rejeitar a operação (aviso vermelho ao operador) → Operador cria a quarentena primeiro, depois marca como avariado. Sem surpresas. Mais passos.  ·  (B) Avisar, mas permitir: deixar o parachoques na prateleira de origem enquanto quarentena é criada → Operador avisa que quarentena falta, cria, depois move. Parachoques fica onde está até resolver. Menos surpresas.  ·  (C) Deixar como está (silencioso) → Continua desaparecendo sem aviso.
- **Recomendação:** Opção 1 (bloquear). Valida se quarentena existe ANTES de tirar de A-02-15. Sem parachoques fantasma.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/devolucoes.ts:209-271

## P052 — Duplicação via duplo clique
- [ ] **vou fazer** · gravidade: grave · tema: Devoluções · fluxo: Devolução de mercadoria avariada
- **Imagina assim:** Quando o operador devolve um item de uma compra de fornecedor
- **Hoje:** Quando o operador clica no botão 'Classificar' duas vezes muito rápido, o sistema recebe duas comunicações entre os sistemas ao mesmo tempo. A primeira busca a devolução (verificando se está aguardando classificação) e começa a registrar os movimentos. A segunda faz a mesma coisa. Se uma das comunicações falha no meio do caminho, a outra continua mesmo assim, podendo criar 3 ou 4 registros de movimentação duplicados.
- **Por que importa:** A devolução fica com movimentação incorreta, o estoque sai errado, e fica confuso qual é o registro real. O operador não consegue mais desfazer porque o sistema criou múltiplos registros em paralelo.
- **Opções:** (A) Bloquear duplas comunicações na rota (verificar a etapa do pedido antes de processar) → Garante que só a primeira comunicação vai funcionar; a segunda é rejeitada automaticamente  ·  (B) Deixar como está (confia no botão desabilitado da tela do navegador) → Risco continua se a conexão for lenta ou houver problema de rede
- **Recomendação:** Implementar a verificação de status na rota. É uma proteção simples, segura e resolve o problema de uma vez.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Devolução de mercadoria avariada")

## P053 — Devolução antiga (antes de maio) não devolve o estoque pro monte quando cancela
- [ ] **vou fazer** · gravidade: grave · tema: Devoluções · fluxo: Devolução com Troca de Peça
- **Imagina assim:** Uma devolução foi registrada antes de 28 de maio. O operador quer desfazer e devolver o estoque. O sistema não consegue encontrar o registro dela e deixa o estoque prisioneiro.
- **Hoje:** Quando tenta desistir da devolução, o sistema procura mas não acha o caminho histórico — o estoque que entrou não volta pro monte.
- **Por que importa:** O produto fica contado como se ainda estivesse em devolução, mas ninguém consegue vender. O saldo fica mentiroso.
- **Opções:** (A) Corrigir a lógica de busca: procurar devoluções antigas por data da transação + tipo, não só por ID → Desclassificar volta a funcionar. Estoque volta pro monte como esperado.  ·  (B) Fazer uma varredura manual agora pra recompor os saldos de devoluções pré-maio que ficaram travadas → Saldo fica correto de uma vez, mas não resolve o código — problema volta a acontecer.
- **Recomendação:** Fazer a correção no código (opção 1). É rápido e impede que o problema aconteça novamente com futuras devoluções.
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:408-411

## P054 — Estoque fica negativo quando dois operadores mexem na mesma prateleira ao mesmo tempo
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Devolução com Troca de Peça
- **Imagina assim:** Mercadoria chega em RECEB-01 com 5 unidades. Um operador marca como danificado (4 para quarentena). Ao mesmo tempo, outro operador tira 3 unidades pra picking. O segundo tenta tirar mais do que existe.
- **Hoje:** O sistema tenta processar os dois ao mesmo tempo. Tira 5, depois tira 3 de novo — saldo fica -3. Mas avisa erro só depois de começar. Marca como 'danificado' fica pela metade: entrou como danificado, mas não saiu da prateleira pra quarentena.
- **Por que importa:** Saldo vira negativo (impossível). Estoque fica numa situação confusa (meia entrada, meia saída), ninguém consegue arrumar.
- **Opções:** (A) Implementar trava/lock: quando começa a marcar como danificado, tranca a prateleira. Outros operadores esperam terminar. → Operações nunca se cruzam. Sempre completa inteiro ou falha inteiro. Saldo sempre positivo.  ·  (B) Deixar como está e ensinar os operadores a terem cuidado pra não clicar ao mesmo tempo → Problema acontece de novo quando alguém esquece ou há pressa. Não é confiável.
- **Recomendação:** Implementar o lock (opção 1). É a forma certa de garantir que duas operações não se pisam. Sem isso, é só sorte não quebrar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:212-271; ledger.ts:95-105

## P055 — Duplo clique em Criar Sessão — pedido duplicado
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Contagem de Estoque em Ciclo
- **Imagina assim:** Supervisor clica o botão 'Criar Sessão' 2 vezes muito rápido
- **Hoje:** O sistema envia 2 pedidos ao banco de dados ao mesmo tempo. O primeiro cria a sessão inteira. O segundo não percebe que já foi criada e tenta criar de novo — pode ficar inconsistente ou gerar duplicação.
- **Por que importa:** Sessões duplicadas confundem toda a contagem: operadores entram em sessões fantasmas, dados de divergência se perdem, supervisor aprova a errada.
- **Opções:** (A) Marcar na prateleira (banco de dados) que sessão já existe pra este galpão + data, rejeita 2ª tentativa → Segundo clique devolve erro, supervisor vê mensagem. Mais seguro.  ·  (B) Se falhar, a rotina volta e tenta novamente com a sessão que já existe → Aparenta funcionar, mas deixa duplicatas no banco — risco latente.
- **Recomendação:** Usar opção 1: deixar o banco rejeitar duplicatas. É mais seguro e nunca deixa dado inconsistente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:45-86, route.ts:48-91

## P056 — Estorno de contagem com 100 movimentos falha no meio
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Contagem de Estoque em Ciclo
- **Imagina assim:** Supervisor contou 50 produtos diferentes, cada um teve ganho ou falta. Total: 100 lançamentos. Aprovou tudo. Depois notou erro e clicou 'Desfazer Contagem'.
- **Hoje:** O sistema tenta desfazer cada um dos 100 lançamentos um a um. Se o 50º lançamento falha (por exemplo, saldo fica negativo), a operação para. Os 49 primeiro já foram desfeitos, os 51-100 ficam como estão. Resultado: estoque fica parcialmente desfeito — semi-desastre.
- **Por que importa:** Estoque fica inconsistente e ninguém sabe exatamente qual movimento foi desfeito e qual não foi. Próxima contagem encontra um bagunço.
- **Opções:** (A) Desfazer todos de uma vez — se qualquer um falhar, nenhum é desfeito → Operação segura. Se falhar, supervisor vê mensagem clara (ex: 'saldo do produto X fica negativo, revise antes de desfazer').  ·  (B) Desfazer um a um, e se falhar, tentar novamente para cada um → Operação frágil. Pode deixar inconsistência invisível.
- **Recomendação:** Desfazer todos de uma vez: tudo ou nada. Se algum desfeito não for possível, a operação inteira falha com aviso claro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:1183-1215

## P057 — Contagem não gruda com o saldo quando tudo falha
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Verificação de Estoque na Hora da Separação
- **Imagina assim:** Um operador conta 8 unidades numa prateleira e registra. O sistema tenta guardar essa informação em duas fases: primeiro muda o saldo, depois registra a contagem. Se o meio falha, uma fase aconteceu e a outra não.
- **Hoje:** Se a rede cai ou o servidor fica lento na metade do caminho, o saldo pode ter mudado mas a contagem não foi registrada (ou vice-versa). Quando o operador tenta novamente, o sistema não sabe se já fez metade do trabalho, então pode criar registros duplicados ou deixar o histórico desconectado.
- **Por que importa:** Seu acerto de estoque fica comprometido. Você acha que contou 8, mas o sistema só aplicou a metade da mudança. Quando chegar o final do dia, o saldo e o histórico de contagens apontam pra lados diferentes.
- **Opções:** (A) Deixar como está (aceitando que contagem e saldo podem desacoplar em caso de falha) → Economiza trabalho de desenvolvimento. Mas o acerto manual fica mais frequente e demorado quando falhas acontecem.  ·  (B) Juntar contagem + saldo numa transação única (tudo-ou-nada) → Contagem e saldo sempre combinam. Mais seguro, mas código mais complexo.
- **Recomendação:** Faça a transação única. É o padrão de segurança em sistemas de estoque. Sem isso, seus acertos de inventário vão custar horas extras.
- **➡️ MINHA ESCOLHA:** 
- **Código:** contagem-inline.ts:99-106, 109-172

## P058 — Operador consegue digitar em uma contagem que já foi finalizada
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Contagem de estoque por prateleira (digitar quantidades que vê)
- **Imagina assim:** Um operador entrou em uma sessão de contagem de prateleiras no dia 10 de maio, contou algumas coisas e saiu. Dias depois, no dia 15 de maio, abre a mesma contagem e clica para entrar novamente. Nessa altura, a contagem já foi checada, aprovada e até aplicada ao sistema.
- **Hoje:** O sistema checa se a contagem ainda está em andamento. Se achar a linha de trabalho do operador anterior, a reutiliza. Não valida se a contagem já foi finalizada, aprovada ou aplicada. Deixa o operador entrar e digitar números novamente.
- **Por que importa:** Se operador digita em uma contagem que já foi aprovada, os números novos desaparecem no vazio — ninguém vai usar aquele trabalho. Fica confusão: operador pensa que digitou, ninguém sabe por quê desapareceu, números errados nunca se corrigem.
- **Opções:** (A) Bloquear entrada se a contagem já saiu da fase em andamento → Operador tenta entrar e recebe mensagem 'essa contagem já foi finalizada'. Tem que chamar supervisor se precisa refazer.  ·  (B) Deixar como está hoje → Operador consegue digitar, mas números desaparecem. Confusão aumenta.
- **Recomendação:** Bloquear. Contagem que saiu de 'em andamento' não deve aceitar operador novo ou antigo. Se precisa corrigir, supervisor cria uma nova contagem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts linhas 193-250

## P059 — Compra chega fora da hora da contagem e some do relatório
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Contagem de Estoque e Ajustes
- **Imagina assim:** Você faz contagem às 10:00 da manhã. Uma compra de fornecedor chega às 10:01 (1 minuto depois) com 20 peças de um produto. O sistema não vê essa compra na hora de conferir se as contas batem. No final, aparece uma diferença falsa (o sistema acha que faltam 20 peças quando na verdade chegaram).
- **Hoje:** O sistema faz uma 'foto' do estoque na hora da contagem. Qualquer coisa que chegue após essa hora não entra na foto — fica de fora. Quando confere os números, o saldo já foi atualizado com a compra (que chegou depois), mas o sistema trata como se aqueles números não existissem.
- **Por que importa:** Você recebe uma compra minutos depois de contar e aparece uma divergência inexplicável. Cria confusão, perde tempo procurando o erro quando na verdade tudo está certo.
- **Opções:** (A) Fechar a contagem mais rápido (menos de 1 minuto) para reduzir a janela de risco → Compras atrasadas entram na próxima contagem. Menos falsos alertas, mas contagem fica 'corrida' e mais chance de operador errar na pressa.  ·  (B) O sistema lê o histórico de estoque desde o início do dia e recalcula tudo → Mais robusto e certo, mas mais lento. Contagem fica mais precisa independente de quando as compras chegam.  ·  (C) Avisar claramente que divergências com compras próximas podem ser falsas → Supervisor sabe que precisa desconfiar e investigar se houve compra. Nem sempre é óbvio.
- **Recomendação:** Escolha a segunda opção. Reconstruir o histórico desde o início é mais confiável e evita surpresas. Custa um pouco mais de tempo de processamento, mas vale a pena pela precisão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario-reconciliacao.ts:164-165, inventario.ts:650-658

## P060 — Contagem parada no meio do caminho quando estoque muda
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Aplicação de ajustes de estoque descobertos em contagem
- **Imagina assim:** Supervisor está aplicando uma contagem com 3 diferenças encontradas (D1, D2, D3). D1 e D2 passam, mas D3 falha porque outro operador mexeu no estoque nesse meio tempo.
- **Hoje:** O sistema aprova D1 e D2 normalmente, mas quando tenta aplicar D3, ele vê que o saldo mudou desde que começou a contar. Aí ele para. D1 e D2 ficam marcadas como 'feito', D3 fica marcada como 'aguardando aprovação', e a contagem inteira fica travada. O saldo fica errado: dois registros foram ajustados mas um não.
- **Por que importa:** Se dois operadores trabalham ao mesmo tempo em estoques diferentes ou não, e um mexe no estoque enquanto o outro está ajustando, o sistema nem avisa e deixa tudo meio-feito. Fica impossível saber se a contagem foi aplicada completa ou não.
- **Opções:** (A) Bloquear o estoque inteiro enquanto aplica a contagem (como 'retirar de circulação') → Ninguém mais mexe naquele estoque enquanto a contagem roda. Fica seguro, mas mais lento se alguém está aguardando.  ·  (B) Se falhar no meio, descartar tudo e voltar ao estado anterior → Ou aplica completo ou não aplica nada. Não fica meio-feito. Supervisor precisa recomençar, mas sabe que pode tentar de novo.  ·  (C) Deixar como está, mas avisar bem claro quando falha → Mais rápido, mas o supervisor precisa ir olhar um por um para ver qual não foi aplicada e tentar de novo manualmente.
- **Recomendação:** Descartar tudo e voltar: é mais seguro e claro. O supervisor vê que 'não funcionou desta vez' e tenta novamente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:1095-1100

## P061 — Uma movimentação de ajuste falha no meio da execução
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Desfazer ajustes de inventário
- **Imagina assim:** Supervisor aplica uma listagem de 3 itens para corrigir a quantidade de estoque. Depois, alguém faz um ajuste manual direto em outra prateleira, reduzindo a quantidade lá. O supervisor clica para desfazer a correção.
- **Hoje:** O sistema consegue desfazer o primeiro item da lista, mas quando tenta desfazer o segundo, retorna erro porque não há estoque suficiente (alguém mexeu). O sistema para aqui: primeiro item foi desfeito com sucesso, segundo não foi desfeito. O supervisor vê erro 500 mas não sabe qual item foi desfeito e qual não foi.
- **Por que importa:** Você fica com dados quebrados no meio do caminho: uma parte da correção foi desfeita, outra não. O estoque mostra quantidades inconsistentes. Na próxima contagem, vai haver confusão sobre o que é real.
- **Opções:** (A) Tudo-ou-nada: se um item falhar, volta tudo ao estado anterior (desfaz o que já tinha desfeito também) → Mais seguro: ou a operação inteira funciona ou nada muda. Mas se está travado em uma prateleira, pode nunca conseguir desfazer.  ·  (B) Desfaz o que consegue e mostra exatamente qual item falhou → Supervisor vê 'consegui desfazer itens 1 e 3, mas o item 2 falhou porque a prateleira não tem estoque'. Ele tenta de novo ou resolve a prateleira primeiro.
- **Recomendação:** Escolha a opção 2 (desfaz o que consegue e avisa). É mais realista: às vezes um desfazimento vai falhar por razões legítimas, e o supervisor precisa saber exatamente qual.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:1196-1210, ledger.ts:44-62

## P062 — Dois operadores tentam receber a mesma transferência ao mesmo tempo — um fica com estoque perdido
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Transferência de estoque entre galpões
- **Imagina assim:** Transferência saiu do galpão A com 3 caixas. Operador João começa a guardar a 1ª caixa (abre o formulário, escolhe onde botar). Operador Maria clica para cancelar a transferência inteira.
- **Hoje:** Maria consegue cancelar e desfaz as 2 caixas que já foram guardadas. João consegue guardar a 1ª caixa mesmo depois. Resultado: a transferência fica marcada como cancelada, mas a 1ª caixa está lá na prateleira sem ninguém saber que existe. Fica órfã no sistema.
- **Por que importa:** Você pensa que cancelou a transferência toda, mas parte dela foi recebida escondido. Quando vier um pedido normal, o estoque dessa caixa órfã não aparece. Causa quebra de cabeça em auditorias.
- **Opções:** (A) Só quem está recebendo consegue cancelar a transferência → Mais seguro. Se João está recebendo, Maria não consegue cancelar. Mas João pode ficar preso se tela dele cair.  ·  (B) Gerente (role especial) consegue cancelar mesmo que alguém esteja recebendo → Mais flexível, mas precisa de outro sistema pra 'liberar' o operador preso se tela dele cair.
- **Recomendação:** Opção 1: configure permissão pra só quem está mexendo conseguir parar. Mas adicione um timeout automático — se o operador cair de internet, após 30 minutos libera o lock automaticamente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:448-562

## P063 — Cancelamento de transferência falha no meio — fica meia desfeita e prende o operador seguinte
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Transferência de estoque entre galpões
- **Imagina assim:** Transferência em recebimento. A 1ª caixa já foi guardada. Sistema tenta desfazer essa 1ª caixa mas a prateleira onde ela está foi deletada (ou está indisponível). Cancelamento bate em erro.
- **Hoje:** Transferência fica meia cancelada. Algumas caixas foram desfeitas, outras não. Se a prateleira desapareceu, a 1ª caixa fica órfã lá dentro. Operador seguinte que tenta receber: sistema diz 'já tem alguém recebendo' mesmo que não tenha. Precisa de admin para limpar tudo via comando de banco de dados.
- **Por que importa:** Você tenta cancelar mas o sistema trava. A transferência inteira perde a rastreabilidade. Estoque fica partida entre recebida (meia) e não recebida (meia).
- **Opções:** (A) Ignorar erro e marcar cancelado de qualquer jeito (o que faz hoje) → Rápido, mas deixa dados inconsistentes. Auditoria consegue rastrear, mas confuso.  ·  (B) Se um erro acontece, desfaz tudo que foi desfeito até agora e deixa a transferência como estava → Mais limpo. Mas operador precisa ver qual foi o erro exato pra resolver (ex: prateleira foi deletada, então recrie a prateleira e tente de novo).
- **Recomendação:** Opção 2: se um erro acontece, desfaz tudo que foi desfeito até agora. E mostre a mensagem de erro específica pro operador (ex: 'Prateleira X foi deletada — entre em contato com gerência'). Assim o sistema fica limpo e sabe-se exatamente o que foi errado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:497-513

## P064 — Transferência perde um item no meio da operação de recebimento
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Recebimento de transferência entre galpões
- **Imagina assim:** Operador começa a registrar a entrada de uma transferência com 3 itens (SKU A, SKU B, SKU C) no galpão de destino. Para o item B, a mercadoria desaparece da base de dados entre o momento que o sistema a leu e o momento que tentou guardar o novo saldo.
- **Hoje:** O sistema registra SKU A com sucesso (aproveita 100 unidades, prateleira P1). Tenta registrar SKU B: o banco de dados volta 'esse produto não existe mais aqui'. O sistema pula pra SKU C, registra com sucesso. A transferência inteira é marcada como 'recebida e guardada', mas SKU B ficou órfão — ninguém sabe que entrou. Próxima vez que alguém olha o saldo de SKU B, o sistema mostra 'ainda em trânsito' mesmo a transferência estar completa.
- **Por que importa:** Se a transferência é marcada como recebida, você acredita que tem a mercadoria. Mas tem um vazio: SKU B está no galpão fisicamente (chegou), mas a transferência não 'fechou' direito. Quando fizer uma venda, pode vender a mesma caixa duas vezes (uma vez pelo saldo sem transferência, uma vez pelo saldo transferido) — e a separação fica impossível.
- **Opções:** (A) Solução rápida: antes de guardar cada item, o sistema verifica se o item ainda existe e lança erro se sumiu. Operador vê 'SKU B desapareceu', tenta de novo. → Problema evitado nessa operação, mas deixa o risco aberto: se alguém deletar itens enquanto o sistema trabalha, pode haver confusão. Aumenta avisos de erro pro operador.  ·  (B) Solução robusta (recomendada): usar uma operação tudo-ou-nada — o sistema trata os 3 itens como 'tudo junto'. Se um falhar, os outros voltam atrás também. Transferência só muda de etapa se os 3 passarem. → Zero risco de estado intermediário. Se SKU B falhar, SKU A e C voltam — operador tenta de novo do zero. Mais seguro, mas talvez mais lento (alguns ms a mais).
- **Recomendação:** Implementar operação tudo-ou-nada. É o padrão na indústria pra operações críticas como recebimento. Reduz de 'pode haver vazio' pra 'nunca há vazio'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:353-378

## P065 — Desfazer recebimento semanas depois quebra o saldo
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Recebimento de transferência entre galpões
- **Imagina assim:** Terça-feira: você recebe uma transferência de 50 unidades de SKU X do galpão A. Estoque de SKU X no galpão B sobe de 50 pra 100 (50 próprio + 50 da transferência). Sexta-feira: operador percebe que foi erro, clica 'Desfazer recebimento'. Enquanto isso, na quarta-feira foi vendido um lote de 60 unidades de SKU X. Saldo agora é 40.
- **Hoje:** Ao clicar desfazer, o sistema estorna os 50 (tira 50 de volta). Saldo fica: 40 - 50 = -10. Sistema mostra saldo NEGATIVO. Você pode ter uma situação onde 'só tem 10 unidades de verdade, mas o sistema diz -10'.
- **Por que importa:** Saldo negativo não deveria ser possível (você não pode vender o que não tem). Se isso acontece, significa que o sistema perdeu o controle de verdade: não sabe se aquele estoque foi realmente vendido ou não. Próximas operações ficam erradas.
- **Opções:** (A) Desfazer sempre, sem validação. Se gerar saldo negativo, operador vê o número vermelho e liga pra você. (Status quo.) → Simples, mas deixa você descobrir o problema só quando tira um relatório. Pode levar dias.  ·  (B) Antes de desfazer, checar: 'essa transferência pode ser devolvida inteira?' Se não: dizer 'você só pode devolver 40 de 50 unidades — o resto já foi vendido. Cheque com separação.' → Operador fica ciente ANTES de fazer besteira. Se disser 'sim, desfaça mesmo assim', aí sim você desfaz (e admite saldo negativo com conhecimento). Mais seguro.
- **Recomendação:** Validar e avisar antes de desfazer. Não bloqueia desfazer (às vezes precisa mesmo com saldo negativo), mas dá transparência ao operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:588-665

## P066 — Dois operadores conseguem receber e cancelar a mesma transferência ao mesmo tempo
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Recebimento de transferência entre galpões
- **Imagina assim:** Operador A está no meio de receber uma transferência (clicou 'Confirmar', sistema está guardando os itens). Operador B, na tela ao lado, clica 'Cancelar' na mesma transferência.
- **Hoje:** B consegue clicar cancelar porque a transferência ainda está com a etapa 'em trânsito' (A ainda não finalizou). Sistema de A insere 50 unidades em prateleira P1. Sistema de B estorna a transferência inteira, devolvendo 50 unidades pro galpão de origem. No fim: A acredita que tem 50 unidades no B, B acredita que não recebeu nada. O saldo fica inconsistente — ou um lado ou outro vai fazer separação errada.
- **Por que importa:** Se dois operadores conseguem mexer ao mesmo tempo na mesma transferência, você tem duas versões da verdade. Isso causa: 1) sobrevenda (A acha que tem 50, tira pra vender, só tem 0 no fim); 2) compras duplas (os galpões ficam confusos, alguém pede uma nova transferência quando na verdade já tem).
- **Opções:** (A) Sem mudança. Operador B tem que ficar atento (olhar pra tela de A antes de cancelar). Risco mitigado por comunicação. → Barato, mas frágil. Basta um dia de pressa e alguém clica errado.  ·  (B) Sistema bloqueia cancelamento: se alguém começou recebimento, botão 'Cancelar' fica cinzento com aviso 'outro operador está recebendo'. Só desbloqueado quando recebimento termina. → Seguro. Operador B vê claramente 'não posso cancelar agora'. Evita 99% dos erros.
- **Recomendação:** Bloquear cancelamento enquanto recebimento ativo. É a proteção padrão em gerenciamento de galpão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:448-562

## P067 — Desfazer recebimento pode deixar os dados desorganizados
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Desfazer o recebimento de uma transferência entre galpões
- **Imagina assim:** Operador descobre que um recebimento estava errado e clica em desfazer.
- **Hoje:** O sistema começa a devolver o estoque pro monte. Devolve a primeira parte (as movimentações). Depois tenta ajustar os itens na conta. Se o segundo ajuste falha (problema no banco de dados), o sistema devolve a mercadoria mas nao consegue ajustar a planilha. Os dados ficam com a mercadoria devolvida mas a papelada ainda diz que estava recebido.
- **Por que importa:** Se os dados ficam desalinhados, a próxima pessoa que mexer no estoque vai ver quantidade errada, separar produto errado, ou dar inventário errado. Pode vender estoque que nao existe ou deixar produto perdido na contagem.
- **Opções:** (A) Desfazer completo: se qualquer etapa falha, voltar tudo como era (nenhuma mercadoria é devolvida). → Dados sempre alinhados. Operador ve que nao conseguiu (sistema diz 'tente de novo'), e tenta novamente depois. Sem risco de saldo errado.  ·  (B) Desfazer em etapas: desfaz o que conseguiu, loga o que falhou e deixa alguém resolver depois. → Processo continua, mas deixa trabalho manual pra resolver depois. Risco de dados desalinhados por dias ate alguem arrumar na mão.  ·  (C) Bloquear desfazer se há risco: sistema avisa 'nao consegui confirmar que é seguro desfazer isso' e nao faz nada. → Nenhuma etapa começa se nao tiver certeza. Operador precisa chamar supervisor, mas dados nunca ficam meio-mutilados.
- **Recomendação:** Usar a opção 1 (desfazer completo ou nada). E' mais seguro pra estoque. Operador vê que falhou, tira um dia pra entender o motivo, e tenta denovo. Sem risco de descobrir depois que faltam 100 peças na contagem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Desfazer o recebimento de uma transferência entre galpões")

## P068 — Dois operadores mexem no mesmo instante: um cancela, outro recebe
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Cancelamento de transferência entre galpões
- **Imagina assim:** Operador A clica 'Cancelar' na transferência. Operador B, na mesma hora, clica 'Receber' no destino. Os dois comandos chegam no servidor quase junto.
- **Hoje:** O sistema começa a desfazer os estornos da entrada enquanto o recebimento está inserindo os movimentos novos. Os dois processos mexem no mesmo estoque ao mesmo tempo.
- **Por que importa:** O saldo fica errado. Uma mercadoria pode ser contada duas vezes, ou desaparecer. O estoque não bate mais com a realidade.
- **Opções:** (A) Travar a transferência enquanto está sendo cancelada (ninguém consegue receber enquanto o cancelamento está acontecendo) → Operador B tenta receber → sistema responde 'transferência está sendo cancelada, tente novamente em alguns segundos'. Depois que A termina, B consegue fazer.  ·  (B) Deixar como está → Continua acontecendo. Saldo fica errado quando coincide.
- **Recomendação:** Implementar o cadeado. Vale a pena pelos estornos que causa quando estoque fica negativo ou duplicado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** transferencias.ts:475-490, receberTransferencia.ts:299-305

## P069 — Pessoa consegue forçar ajuste de estoque sem estar autorizada
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Ajuste de estoque manual
- **Imagina assim:** Operador sem permissão para ajustar estoque
- **Hoje:** A tela mostra o botão de 'Registrar ajuste' desativado, dizendo 'sem permissão'. Mas alguém que conhece tecnologia pode burlar isso pelo navegador ou linha de comando e consegue fazer o ajuste mesmo assim, porque o sistema por trás (onde os dados realmente mudam) não verifica a permissão.
- **Por que importa:** Qualquer pessoa que queira burlar o sistema consegue fazer ajustes que não deveria fazer — pode inflar estoque, falsificar entradas, sem deixar rastro de que pessoa não autorizada fez. Vulnerabilidade de segurança.
- **Opções:** (A) Manter como está → Continua vulnerável. Qualquer operador consegue forçar ajuste mesmo sem permissão.  ·  (B) Adicionar validação no sistema por trás → Sistema por trás recusa ajuste se operador não tem permissão 'operacoes.ajuste_manual'. Burla fica impossível.
- **Recomendação:** Implementar a validação no sistema por trás imediatamente. É uma falha de segurança real.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/ajuste/page.tsx:18; src/app/api/wms/ajuste/route.ts:2-3

## P070 — Desfazer um ajuste que já foi vendido causa saldo negativo e trava o sistema
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Desfazer um ajuste de estoque
- **Imagina assim:** Você entrada 20 unidades de um produto. Depois, o sistema separa 15 delas para um pedido. Sobram 5 em estoque. Você tenta desfazer o ajuste original (clica desfazer). O sistema tenta voltar com as 20 unidades, mas só há 5 livres — quer devolver 20 que não existem. Saldo vai pra menos 15 e o sistema trava com erro.
- **Hoje:** Se o ajuste foi entrada pura (ninguém pegou ainda), desfaz normal. Mas se alguém já pegou para separar um pedido, trava com erro.
- **Por que importa:** Operador pensa que clicou e foi, mas não foi. Fica confuso. Além disso, saldo fica errado (negativo), e qualquer pedido novo que chegar vê números impossíveis.
- **Opções:** (A) Rejeitar o desfazer e avisar: 'Não dá pra desfazer este ajuste — já foi usado em 15 saídas (separação de pedido). Se quer corrigir o saldo, faça outro ajuste.' → Operador não fica confuso. Saldo segue certo. Quer corrigir, entra com +5 ou -5 novo.  ·  (B) Permitir desfazer parcial: você escolhe quantas das 20 quer desfazer (ex: 5), deixa 15 como vendidas. → Mais flexível, mas operador precisa saber quanto já foi gasto. Fica complexo.
- **Recomendação:** Opção 1. Simples, seguro, treina operador a pensar diferente (ajuste que virou venda não desfaz — faz outro ajuste).
- **➡️ MINHA ESCOLHA:** 
- **Código:** ACD-003 / situacao: Ajuste entrada 20 unid → Pedido 15 → Desfazer falha com saldo -15

## P071 — Dois pedidos criados quando vendedor clica rápido duas vezes
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Criar uma venda na mão
- **Imagina assim:** O vendedor está criando uma venda manual. A internet está lenta. Ele clica no botão 'Criar e baixar estoque', não vê resposta imediata, e clica de novo.
- **Hoje:** O sistema deveria bloquear o segundo clique — a tela fica cinzenta mesmo. Mas se por algum motivo o bloqueio falha (por exemplo, desativado), dois pedidos são criados com os mesmos itens e o mesmo cliente. Cada clique gera um código único de identificação diferente no sistema, então o sistema não reconhece que é o mesmo pedido sendo submetido de novo.
- **Por que importa:** O cliente recebe dois pedidos iguais em vez de um. Na contabilidade, aparecem duas vendas. No estoque, o saldo cai o dobro. Operador tem trabalho de arrumar: cancelar o pedido fantasma, refazer números.
- **Opções:** (A) Gerar o código único uma vez ao abrir o formulário (em vez de gerar a cada clique) → Segundo clique usa o mesmo código. O sistema por tras reconhece, ignora, retorna o pedido já criado. Um pedido só.  ·  (B) Deixar como está (código novo a cada clique) → Risco permanente de duplo clique = dois pedidos. Evento raro, mas acontece.
- **Recomendação:** Mudar para gerar o código único ao abrir o formulário. É a prática padrão em sistemas de vendas sérios.
- **➡️ MINHA ESCOLHA:** 
- **Código:** page.tsx:183

## P072 — Operador marca item: pode contar duas vezes
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Separação de Pedidos (operador marca itens conforme apanha do galpão)
- **Imagina assim:** Operador pega 3 unidades do produto e marca no tablet
- **Hoje:** O sistema registra que saíram 3 unidades do estoque (saldo vai de 10 para 7). A reserva é liberada (volta ao monte). Mas se apertar duas vezes por acaso, não faz verificação — pode tentar registrar a saída novamente.
- **Por que importa:** Se o sistema contar a mesma saída duas vezes, o saldo fica errado. Um produto que tem 10 unidades pode ser registrado como 4 (10 - 3 - 3) quando na verdade tem 7. Depois quando chega estoque de verdade, os números não batem e ninguém sabe quantas peças existem de verdade.
- **Opções:** (A) Verificar se aquele item já foi marcado antes de registrar → Se foi, não faz nada (ignora o segundo clique). Simples e rápido.  ·  (B) Usar um identificador único (como um ID de transação) e guardar qual foi a última processada → Mais seguro. O sistema se recusa a processar a mesma transação duas vezes, sempre.
- **Recomendação:** Escolher a opção 2. Quando você marca um item, o sistema gera um ID para aquela ação. Se chega uma segunda cópia do mesmo ID, ele recusa: 'já foi processado'. Assim mesmo que alguém clique 100 vezes, só conta uma.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:82-179

## P073 — Operador clica em Concluir e a tela demora: clica de novo
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Separação de Pedidos (operador marca itens conforme apanha do galpão)
- **Imagina assim:** Operador terminou de pegar 3 pedidos (números 1, 2, 3). Clica o botão 'Concluir'
- **Hoje:** Sistema marca 2 deles como concluído. Página não responde rápido. Operador clica de novo no botão 'Concluir'. Segunda vez, o sistema recebe a ordem de novo, mas 2 já estão concluídos. Em vez de falar 'ok, 2 já estavam prontos', ele responde 'nenhum foi concluído' e marca todos como pendentes ainda.
- **Por que importa:** Cria confusão na tela: o operador vê que seus pedidos aparentemente voltaram a ser inconclusos, e ele não sabe se clicou ou não. Pode marcar tudo de novo por engano, causando problemas nos números.
- **Opções:** (A) Segunda tentativa recusa com erro de conflito: 'você já enviou isso, espera' → Operador sabe que algo aconteceu, fica atento.  ·  (B) Segunda tentativa retorna o mesmo resultado da primeira: 'ok, 2 concluídos, 1 pendente' → Operador vê que deu certo mesmo assim, continua tranquilo.
- **Recomendação:** Escolher opção 2. Se o operador clica duas vezes, a tela mostra a mesma resposta. Assim ele fica confortável de que 'ja estava feito'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/concluir/route.ts:103-147

## P074 — Nota fiscal sumiu ou está inválida, mas pedido já marcado
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Separação de Pedidos (operador marca itens conforme apanha do galpão)
- **Imagina assim:** Operador marca 5 unidades do produto. Sistema cria a saída. Mas a nota fiscal da venda foi cancelada ou sumiu da base
- **Hoje:** O sistema marca que saiu estoque (movimento de saída criado), mas depois quando tenta ligar esse movimento à nota fiscal, descobre que ela não existe ou é inválida. O sistema loga um aviso e segue em frente. Pedido fica marcado como 'estoque lançado' mas ninguém sabe qual nota fiscal ele pertence. Se depois precisar revisar ou fazer devolução, a rastreabilidade some.
- **Por que importa:** Estoque baixado sem comprovante fiscal é risco. Se vier uma fiscalização, você não consegue explicar por que saiu mercadoria. Além disso, se o cliente devolver, você não consegue ligar a devolução ao documento original.
- **Opções:** (A) Se a nota fiscal falhar, o sistema para e avisa: 'não consegui registrar porque a nota fiscal desapareceu' → Operador é forçado a resolver: ou recupera a nota fiscal, ou cancela o pedido. Fica tudo rastreável.  ·  (B) Se a nota fiscal falhar E o pedido não precisa dela (ex: ajuste de posição), ignora e continua → Funciona bem para alguns tipos de operação, mas precisa saber quando ignora e quando não.
- **Recomendação:** Escolher opção 1. Quando é venda de verdade (tem cliente, tem NF), exigir a NF. Se NF falhar, para e avisa. Sem isso, estoque fica flutuando.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/execution-worker-wms.ts:66-78

## P075 — Estorno de venda manual sai pela metade
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Venda Manual (consulta de estoque + criação de pedido)
- **Imagina assim:** Vendedor cria uma venda manual com 5 produtos diferentes. Consegue guardar os 3 primeiros normalmente, mas na hora de guardar o 4º, o sistema acusa um erro (porque o estoque desse produto foi reservado para outra venda). O sistema tenta desfazer o que fez (os 3 primeiros), mas consegue desfazer só os 3.
- **Hoje:** O sistema guarda uma lista dos 3 movimentos que fez. Quando falha no 4º, entra no código de desfazer. Tenta reverter cada uma das 3 operações antigas — mas se uma dessas reversões falhar (por exemplo, cai a base de dados no meio), o sistema deixa a reversão incompleta e deleta o pedido mesmo assim.
- **Por que importa:** Se o banco ficar instável no meio de um desfazer, seu estoque fica meio-caminho. Alguns produtos voltam pra prateleira (errado), outros não. Inventário sai desalinhado com a realidade, e você descobre só quando conta a prateleira no fim do mês.
- **Opções:** (A) Deixar como está: cada reversão é independente → Mais rápido, mas risco de inconsistência se cair energia no meio  ·  (B) Trancar a prateleira inteira enquanto desfaz → Ninguém mexe na prateleira até terminar; garante que os 3 produtos voltam ou nenhum volta  ·  (C) Se falhar uma reversão, falhar todas e logar o erro pra análise → Admin sabe que deu problema e pode arrumar manualmente depois
- **Recomendação:** Use a opção 2 (trancar a prateleira inteira). Se cair energia, a trava se libera sozinha quando o sistema volta. Garante que ou você desfaz tudo ou nada, nunca meio-caminho.
- **➡️ MINHA ESCOLHA:** 
- **Código:** criar/route.ts:515-538

## P076 — Atribuição a vendedor que saiu da empresa
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Reatribuição do responsável de uma venda
- **Imagina assim:** Admin tenta atribuir um pedido a Carlos, que já não trabalha mais aqui (marcado como desligado no sistema).
- **Hoje:** O sistema deixa atribuir assim mesmo. Carlos aparece no histórico do pedido como vendedor, mas ele não trabalha mais.
- **Por que importa:** Pode confundir quem vê o relatório depois. 'Por que esse pedido tem Carlos?' Se Carlos deixou de ter acesso, ele não deveria aparecer como opção.
- **Opções:** (A) Modo 1: Rejeitar atribuição com mensagem → Admin clica em Carlos → sistema mostra 'Carlos está desligado' → atribuição não funciona. Admin escolhe outro.  ·  (B) Modo 2: Não deixar vendedor inativo aparecer na lista → Admin abre dropdown de vendedores → vê só quem está ativo. Carlos nem aparece.
- **Recomendação:** Use o Modo 2 — mais limpo. Quem está desligado não deveria aparecer pra ser escolhido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/vendas/criar/route.ts:159 vs. src/app/api/wms/vendas/[id]/vendedor/route.ts:66-92

## P077 — Cancelamento interrompido deixa estoque errado
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Cancelamento de Vendas
- **Imagina assim:** Um vendedor cancela uma venda que precisa devolver mercadoria de 3 lugares diferentes. O sistema devolve a primeira mercadoria, depois a segunda, mas quando tenta devolver a terceira, a conexão cai. O sistema interrompe.
- **Hoje:** A primeira e a segunda mercadoria foram devolvidas pro estoque. A terceira ficou retida (ninguém sabe que precisa devolver). O pedido continua marcado como se estivesse ativo, não como cancelado.
- **Por que importa:** Quando você cancela uma venda, o cliente precisa receber a refação certa do que foi vendido. Se o sistema devolve só 2 de 3 devoluções, o saldo fica estourado — você não sabe quantas peças realmente estão na prateleira. Isso vira a base de todas as outras decisões de venda.
- **Opções:** (A) Agrupar as 3 devoluções em uma operação indivisível — só marca como cancelado se conseguir devolver as 3 ao mesmo tempo → Se falhar no meio, volta tudo ao estado anterior (de novo a venda está lá, nada foi devolvido). O vendedor tenta de novo. Estoque sempre consistente.  ·  (B) Se falhar na 3ª devolução, desfazer automaticamente as devoluções 1 e 2 também (tipo um Ctrl+Z) → Mesma garantia acima — o pedido volta inteiro ou nada muda. Estoque seguro.
- **Recomendação:** Escolher a opção 1 (agrupar como bloco único). É a mais simples e faz o sistema todo andar junto.
- **➡️ MINHA ESCOLHA:** 
- **Código:** flow-055

## P078 — Não consegue desfazer uma realocação quando já foi parcialmente desfeita
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Mudança de estoque entre prateleiras (reabastecimento de picking)
- **Imagina assim:** Operador move 5 caixas de um lugar pra outro. Depois tenta reverter, mas o sistema diz 'já teve estorno parcial' e não deixa desfazer o restante.
- **Hoje:** Quando o operador clica em reverter depois que já desfeitas 3 caixas, o sistema trava com mensagem de erro. As outras 2 caixas ficam penduradas — 3 voltaram, 2 ainda estão no lugar errado.
- **Por que importa:** Operador fica preso num estado onde não consegue corrigir o erro. Estoque fica bagunçado — 2 caixas desaparecidas da contagem.
- **Opções:** (A) Permitir reverter só a parte que sobrou (as 2 caixas de 5) → Operador termina de desfazer. Tudo fica limpo. Mais trabalho no código, mas resolve.  ·  (B) Limpar automaticamente a parte antiga e deixar reverter tudo de novo → Sistema tenta outra vez, mas pode ficar mais confuso pra operador.
- **Recomendação:** Escolha a primeira: permitir desfazer só o que falta. Deixa claro pra operador o que ele tá desfazendo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:388-392

## P079 — Fornecedor importante não tem tempo de entrega configurado
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Atualização de cobertura de estoque
- **Imagina assim:** Produto Z é marcado como 'fornecedor preferencial', mas ninguém preencheu o campo 'tempo de entrega' na configuração do fornecedor.
- **Hoje:** O sistema consulta a configuração do fornecedor preferencial. Quando encontra que o tempo de entrega está vazio, a análise de cobertura diz 'ok' (tudo certo) — mas isso é uma falsa segurança.
- **Por que importa:** Sem saber quanto tempo o fornecedor demora para entregar, o sistema não consegue calcular se a quantidade de estoque é suficiente. Resultado: pedidos esperam mais que o previsto ou estoque acaba sem tempo de repor.
- **Opções:** (A) Forçar o preenchimento: quando marcar um fornecedor como 'preferencial', obrigar a entrada do tempo de entrega (ex: não deixa salvar sem preencher). → Impossível marcar 'preferencial' sem completar a informação. Garante que análise de cobertura sempre tem dados.  ·  (B) Usar padrão automático: se tempo de entrega não foi preenchido, o sistema assume 7 dias por padrão. → Permite marcar 'preferencial' sem preencher agora, mas usa uma estimativa segura. Se for menor, tudo bem; se for maior, pode gerar aviso.
- **Recomendação:** Escolha a opção 1 (forçar preenchimento). Evita armadilhas silenciosas. Quando o gerente de compras marcar um fornecedor como importante, tem que informar o tempo de entrega — é uma pergunta obrigatória, como pedir RG para abrir conta bancária.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260520f_mviews.sql:55-59

## P080 — Mesmo pedido é separado duas vezes quando o sistema detecta a entrega
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Detecção automática de saídas diretas do recebimento
- **Imagina assim:** Seu estoque recebe uma compra do fornecedor. O sistema detecta que essa compra corresponde a um pedido já separado. Ele tira esse pedido pra fazer uma separação especial (cross-dock). Alguém (ou outro sistema) dispara essa rotina de separação de novo, e o sistema tenta separar o mesmo pedido outra vez.
- **Hoje:** Na primeira vez que a rotina roda, o pedido realmente vira 'separado'. Mas o sistema não marca que isso já aconteceu. Se a rotina é chamada uma segunda vez, ele tenta separar de novo — sem saber que já fez isso. Um pedido que deveria ser separado 1x acaba passando pela separação 2x.
- **Por que importa:** Você perde rastreabilidade. A mesma peça pode ser contada em dois momentos diferentes. Funcionário pode tentar embalar a mesma coisa duas vezes, gerando confusão na separação e atrasos no envio.
- **Opções:** (A) Parar antes de separar e avisar que o pedido já foi processado nessa rota → Simples, seguro. Se alguém chamar a rotina de novo, o sistema ignora (zero risco).  ·  (B) Deixar rodar, mas dentro de uma transação que garante que só 1 pessoa/sistema muda o status de cada vez → Mais complexo de implementar. Protege contra cliques simultâneos, mas não pra quem chama de novo 5 minutos depois.
- **Recomendação:** Opção 1. É a que menos efeitos colaterais tem. Rápido de fazer, fácil de testar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Detecção automática de saídas diretas do recebimento")

## P081 — Dois comandos tentam mudar a mesma prateleira/pedido ao mesmo tempo
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Detecção automática de saídas diretas do recebimento
- **Imagina assim:** O sistema está separando um pedido (status 'em separacao'). Nesse mesmo instante, a rotina de detecção de entrega do fornecedor manda um comando pra mudar o status desse pedido pra 'separado'. Ambos tentam mexer no mesmo pedido, simultaneamente.
- **Hoje:** O comando que muda o status não verifica qual é o status antes de mexer. Se o pedido já é 'em_separacao', o sistema sobrescreve pra 'separado' sem se importar. Se dois comandos chegam na mesma milissegundo, pode haver confusão sobre qual status é o verdadeiro.
- **Por que importa:** Pedido desaparece do fluxo de separação sem o pessoal saber. Ou fica preso numa etapa intermediária, invisível pros sistemas que vêm depois (embalagem, envio).
- **Opções:** (A) Antes de mudar, o sistema verifica 'status é realmente em_separacao?'. Se não for, para e avisa. → Previne sobrescrita. Alguém tem que investigar por que não conseguiu mudar — melhor saber agora do que descobrir no final.  ·  (B) Mudar de qualquer jeito, mas deixar um log do que foi sobrescrito, pra depois consultar → Permite que continue, mas fica mais difícil entender o que deu errado. Péssimo pra auditoria.
- **Recomendação:** Opção 1. Todo sistema que mexe em status tem que fazer essa validação. É padrão de segurança.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Detecção automática de saídas diretas do recebimento")

## P082 — Mudança de etapa do pedido trava sem aviso
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Quando estoque chega, ligar de novo os pedidos presos esperando compra
- **Imagina assim:** Todos os itens do Pedido 1 saíram da compra do fornecedor (foram recebidos corretamente). O sistema tenta mudar o pedido de etapa automaticamente para 'aguardando Nota Fiscal'.
- **Hoje:** A mudança de etapa falha no banco de dados (erro de permissão, chave estrangeira ou restrição). O pedido fica preso sem avançar, e ninguém é avisado. O operador precisa clicar manualmente no pedido para fazer ele sair dessa etapa.
- **Por que importa:** Pedidos presos em etapas antigas não fluem pro processo de separação. O galpão fica esperando Notas Fiscais que o sistema não sabe que chegaram. Operador só descobre manualmente.
- **Opções:** (A) 1. Ignorar (deixar como está) → Pedidos ficam travados diariamente. Operador descobre horas depois, ao revisar manualmente.  ·  (B) 2. Tentar novamente automaticamente 3x (30s, 5min, 1h depois) → Maioria dos erros passageiros se resolve sozinha. Se falhar mesmo assim, cria alerta visível.  ·  (C) 3. Reverter pedido para etapa anterior automaticamente → Pedido volta a 'validação', operador vê na fila e pode investigar manualmente.
- **Recomendação:** Opção 2: tentar novamente automaticamente com alerta. Assim o sistema tenta se recuperar sozinho, mas avisa o operador se algo está realmente errado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reconciliador-oc.ts:268-286

## P083 — Pedido pronto pro envio mas estoque não foi descontado do sistema
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Reconciliação de pedidos quando entra estoque novo
- **Imagina assim:** Pedido chegou na última etapa (separado, embalado, pronto pra enviar). Na verdade, o papel saiu do WMS (chegou a nota fiscal de venda). MAS o sistema ainda não descontou aquele estoque da sua conta.
- **Hoje:** O sistema detecta isso quando faz a varredura de pedidos (a cada 10min): procura pedidos que tem a nota fiscal de venda mas o estoque não foi lançado como saída. Quando acha, marca como erro tipo 'saída sem desconto'.
- **Por que importa:** Seu estoque fica errado. Se o sistema diz que você tem 100 unidades, mas 15 já saíram no pedido, você acha que tem 100 e vende de novo aquelas 15 — sobrevenda.
- **Opções:** (A) Revisar se o pedido 123 foi realmente embalado e despachado → Se foi: sistema marca como 'estoque descontado', números ficam corretos. Se não foi: sistema desfaz tudo, volta o estoque pro monte.  ·  (B) Deixar como está (não correto, vai dar problema no saldo) → Seu estoque fica com 100 quando deveria ter 85. Próximos pedidos podem sobrevender — criará dívida com cliente.
- **Recomendação:** Quando o sistema avisar, um gerente deve confirmar imediatamente se o pedido saiu mesmo. Se sim, clica um botão no sistema pra registrar. Não deixa passar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:38 + migration 20260530:43-57 + execution-worker-wms.ts:198

## P084 — Pedido pronto mas estoque apartado pro pedido ainda não foi devolvido
- [ ] **vou fazer** · gravidade: grave · tema: Estoque apartado pros pedidos (reservas) · fluxo: Reconciliação de pedidos quando entra estoque novo
- **Imagina assim:** Pedido aprovado: você apartou 20 unidades pra ele no início. Agora o pedido chegou na embalagem e está pronto pro envio. MAS aquelas 20 unidades ainda estão registradas como 'apartadas pro pedido' — nunca foram marcadas como efetivamente saídas.
- **Hoje:** Rotina que roda sozinha (a cada 10min) procura por pedidos que estão embalados ou prontos pra envio. Vê que tem estoque apartado vivo (guardado no nome daquele pedido) mas nenhum movimento de saída. Alerta: 'Pedido embalado com apartado não consumido'.
- **Por que importa:** Aquelas 20 unidades ficam invisíveis. Elas não estão ni na venda, nem no estoque livre — estão presas no pedido. Seu gerente olha pra planilha e vê disponível=30, mas na verdade tem só 10 (20 estão congeladas).
- **Opções:** (A) Confirmar que o pedido saiu e liberar aquelas 20 do apartado (converter em saída final) → Estoque livre volta ao normal. Sistema mostra corretamente: tinha 50, apartou 20 pra pedido, pedido saiu → estoque fica 30. Disponível volta a ficar certo.  ·  (B) Deixar congelado (sem fazer nada) → Aquelas 20 unidades somem pra sempre dos seus números. Disponível fica errado. Seu estoque real não bate com o que o sistema diz.
- **Recomendação:** Não deixar isso pendurado. Assim que o sistema avisar, o gerente entra, confirma que o pedido saiu mesmo (checa nota fiscal) e libera o apartado. Se fizer isso no dia, estoque fica sempre certo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** migration 20260530:61-77 + execution-worker-wms.ts:145-155

## P085 — Pedido aprovado parcialmente: item 1 apartou certo, item 2 falhou e ninguém viu
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Reconciliação de pedidos quando entra estoque novo
- **Imagina assim:** Pedido com 2 itens: SKU-A (20 un) e SKU-B (5 un). Loja manda aviso de novo pedido. Sistema tenta apartar: SKU-A apartou OK (20 un saem do livre). SKU-B falha (banco de dados muito lento). Sistema pega a exceção, registra num log, e continua como se nada tivesse acontecido — pedido fica como 'aprovado e processando'.
- **Hoje:** Chega um pedido com 2 peças. A primeira peça (A) é apartada com sucesso. Segunda reserva falha (erro de conexão), a exceção é capturada, logada no histórico como 'aviso', MAS pedido segue pra fila de processamento como se estivesse 100% aprovado.
- **Por que importa:** Seu pedido vai pra separação com 2 itens. Operador vê na lista e vai buscar os 2. Mas o sistema só tem apartado 1 (SKU-A). Na hora que tenta pegar SKU-B, descobre que não tem saldo — teve um erro invisível na aprovação.
- **Opções:** (A) Rejeitar TODA a aprovação se qualquer item falhar → Loja recebe mensagem 'pedido rejeitado, tente novamente'. Nada fica parcial. Mais seguro, mas pedido legítimo pode ser rejeitado por puro erro de conexão — cliente reclama.  ·  (B) Aceitar aprovação parcial (SKU-A apartado) e avisar o operador que SKU-B não foi apartado → Pedido entra pra separação, mas operador vê que item 2 não tem estoque — pode pedir pra loja confirmar ou cancelar esse item. Mais flexível, menos erro, mas precisa de UI clara.
- **Recomendação:** Escolha rejeitar TODA a aprovação — é mais simples e mais seguro. Se algo falha na aprovação, rejeita tudo. Loja retenta 2 minutos depois, funciona de primeira. Evita essas situações de 'meio-aprovado'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** webhook-processor-wms.ts:587-605

## P086 — Correção de estoque não fica registrada no sistema
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Um operador vê que a prateleira tem 3 caixas mas o sistema mostra 5. Clica no número e muda para 3.
- **Hoje:** O sistema manda a correção pro Tiny (a loja), atualiza a tela do operador. Mas NÃO deixa registro dessa mudança. Só o Tiny sabe que foi ajustado.
- **Por que importa:** Quando olhar o histórico depois, não vai saber quem fez a correção, quando foi, ou por quê. Se tiver um erro, não consegue desfazer só o ajuste dele — tem que mexer em tudo de novo. Auditoria fica impossível.
- **Opções:** (A) Registrar só os ajustes feitos (sem o registro das movimentacoes de estoque completo) → Fica um histórico básico, mas sem saldo anterior/posterior. Não dá pra auditoria completa.  ·  (B) Registrar com estorno reverso (cada ajuste gera dois registros: saída e entrada) → Fica mais pesado, mas a trilha é 100% imutável e reversível. Qualquer operação fica auditável.  ·  (C) Não registrar nada (como tá hoje) → Continua invisível. Problema persiste.
- **Recomendação:** Opção 2: registrar com rastreabilidade total. Custa um pouco mais, mas torna cada correção reversível e auditável — essencial pra erros e reconciliação.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:121-137, 148-151

## P087 — Clique duplo no enter pode corrigir o estoque duas vezes
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Operador digita '3' e bate Enter. Antes da tela responder, bate Enter de novo por nervosismo.
- **Hoje:** Dependendo da velocidade da internet, o sistema pode processar as duas requisições. Se for lento, a segunda chega enquanto a primeira ainda tá sendo feita. Resultado: pode aplicar a correção duas vezes (ou ficar indeterminado qual ganhou).
- **Por que importa:** Estoque sai de 5 pra 3, quando deveria ser 3 uma vez só. Se tiver 2 cliques num produto de alto valor, o estoque fica errado.
- **Opções:** (A) Desabilitar só na tela (loading state) → Evita a maioria dos casos, mas se a rede pisca no meio, perde o bloqueio.  ·  (B) Validar no sistema com ID único → Seguro 100%. Mesmo que batam Enter 10 vezes, só aplica uma vez.  ·  (C) Não fazer nada → Segue com risco de dupla aplicação em momentos de internet lenta.
- **Recomendação:** Opção 2: usar ID único. Combina a segurança de bloquear a tela + garantia de que o sistema rejeita a segunda requisição. Custa pouco, protege 100%.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:20-48

## P088 — Corrigir estoque depois que o pedido já foi aprovado/começou a separação
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Um pedido foi aprovado (separação começou em outro galpão há 10 minutos). Operador vê que marcou estoque errado e quer 'corrigir' de 10 pra 5.
- **Hoje:** O sistema deixa corrigir. Manda a nova quantidade pro Tiny. Mas a separação lá em São Paulo tá esperando encontrar 10 caixas — agora só tem 5. Não avisa ninguém.
- **Por que importa:** Separação fica faltando produto, pedido atrasa ou falha. E não há registro de que alguém mexeu no estoque depois do ok. Sistema fica desincronizado.
- **Opções:** (A) Deixar corrigir em qualquer etapa (como hoje) → Flexível, mas quebra a separação e deixa sem trilha.  ·  (B) Bloquear após aprovação, permitir só em 'pendente' → Força disciplina: ou corrige antes de aprovar, ou desfaz a separação e refaz.
- **Recomendação:** Opção 2: bloquear após aprovação. Força a pessoa a pensar antes de apertar ok, e garante que ninguém mexe no estoque enquanto a máquina tá separando.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:49-62

## P089 — Correção é salva no Tiny mas internet cai na volta — fica desincronizado
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Operador ajusta de 5 pra 3. Sistema manda pro Tiny, Tiny aceita e seta 3. Mas na volta, a internet falha (timeout ou erro de rede). Operador vê erro 'falha ao ajustar estoque'.
- **Hoje:** Tiny já tem 3. O registro das movimentacoes de estoque local não foi escrito (porque a volta falhou). Siso (banco local) não sabe que mudou. Resultado: Tiny diz 3, mas Siso diz 5. Fila de sistema fica confusa.
- **Por que importa:** Desincronização silenciosa: Tiny e sistema local discordam do saldo real. Próximo pedido pode validar contra número errado.
- **Opções:** (A) Deixar como tá (falha silenciosa) → Continua com risco de desincronização.  ·  (B) Retry automático com backoff → Recupera a maioria das falhas de rede transitórias. Se ainda falhar, marca como pendente pra revisar.
- **Recomendação:** Opção 2: retry com backoff exponencial + marca como pendente se falhar. Recupera erros temporários e deixa rastro dos permanentes.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:121-138

## P090 — Corrigir saldo sem considerar se produto tem reserva de outro pedido
- [ ] **vou fazer** · gravidade: grave · tema: Estoque apartado pros pedidos (reservas) · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Produto tem 10 caixas no total. Pedido A já reservou 8 (apartadas). Disponível = 2. Operador vê '10' e corrige pra 5.
- **Hoje:** Sistema manda novo saldo pro Tiny. Tiny seta 5. Sistema retorna saldo=5. MAS, a reserva de Pedido A ainda é 8. Invariante quebra: disponível = 5 - 8 = NEGATIVO. Sistema mostra produto com estoque negativo.
- **Por que importa:** Estoque negativo = pedido vai ficar com promessa que não consegue cumprir. Validação quebrada.
- **Opções:** (A) Deixar corrigir sem validação (como hoje) → Quebra invariante, permite estoque negativo.  ·  (B) Validar: novo_saldo >= apartado. Se não, rejeitar. → Força sequência: ou liberta as reservas primeiro, ou usa ajuste de inventário.
- **Recomendação:** Opção 2: validar. Pequeno check, mas impede situações impossíveis.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:139-151

## P091 — Galpão muda no meio do caminho — estoque fica em lugar errado
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Pedido P123 chega com galpão CWB. Sistema separa 500 peças de lá. Admin muda o galpão pra Vault. Sistema tenta guardar no Tiny em Vault, mas as peças estão em CWB.
- **Hoje:** 1) Pedido P123 chega com depósito 100 (CWB). Sistema aprova: 500 peças encontradas, envia pra separação. 2) Admin muda a configuração pra depósito 200 (Vault). 3) Sistema tenta atualizar o Tiny dizendo que guardou em Vault. Mas as peças estão em CWB — Tiny fica confuso.
- **Por que importa:** Quando o cliente pede rastreamento ou fazer reposição futura, o Tiny diz que tem 500 peças em Vault mas elas nunca chegaram lá. Inventário fica inconsistente.
- **Opções:** (A) Bloquear mudança de galpão depois que pedido já roteou → Pedido fica vinculado ao galpão original. Não resolve problema se admin mudar ANTES de processar, só após.  ·  (B) Salvar galpão no pedido (na criação ou rota). Sistema usa esse galpão pra sempre. → Mesmo que admin mude a config geral, esse pedido segue o galpão gravado. Consistente até o fim.  ·  (C) Deixar como está (dinâmico) → Continua com risco de inconsistência entre loja e galpão.
- **Recomendação:** Opção 2: salvar galpão no pedido na hora que roteia. Faz a lógica simples e imune a mudanças administrativas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:108-115 (lê deposito_id dinamicamente de siso_tiny_connections, nao do pedido)

## P092 — Pedido cancelado mas saldo não volta na loja
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Pedido de 300 unidades é separado e marcado como guardado no Tiny. Depois é cancelado. Sistema devolve as 300 pra prateleira interna, mas Tiny continua achando que tem 300 menos.
- **Hoje:** 1) Pedido chega com 300 unidades. Sistema marca: estoque apartado no Tiny. 2) Pedido é cancelado (loja envia aviso). 3) Sistema libera as 300 peças pro estoque interno. 4) MAS Tiny continua mostrando 300 a menos — nunca recebeu ordem de devolver.
- **Por que importa:** Saldo em Tiny fica permanentemente baixo. Loja oferece produto que na verdade não tem. Clientes pedem produtos indisponíveis.
- **Opções:** (A) Hoje: libera só internamente. Deixar como está. → Tiny continua com saldo errado. Problema persiste.  ·  (B) Ao cancelar, chamar Tiny pra estornar as 300 peças → Saldo em Tiny volta ao normal. Loja oferece quantidade certa.  ·  (C) Admin entra manual em Tiny pra corrigir cada cancelamento → Funciona mas é manual e propenso a erro.
- **Recomendação:** Opção 2: automático. Quando cancela, sistema avisa Tiny pra devolver os mesmos itens.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/webhook/tiny/route.ts:191-245 (libera reservas locais mas não estorna em Tiny)

## P093 — Galpão não tem código — sistema não sabe onde guardar
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Admin configura conexão com Tiny mas esquece de escolher qual galpão usar (Tiny deixa em branco ou vazio).
- **Hoje:** 1) Pedido chega pra processar. 2) Sistema procura: qual galpão usar? Acha vazio. 3) Manda pro Tiny sem especificar galpão. 4) Tiny usa o primeiro da lista (ninguém sabe qual é). 5) Pode ser que use o errado.
- **Por que importa:** Estoque é contado em galpão aleatório. Pode esvaziar prateleira errada ou deixar stock em lugar inacessível.
- **Opções:** (A) A tela não deixa salvar config sem galpão selecionado → Config incompleta fica impossível. Admin é obrigado a completar.  ·  (B) O sistema por tras rejeita pedido com erro se galpão não tiver sido configurado → Admin vê erro, completa a config. Pedido processa depois.  ·  (C) Deixa dinâmico, a tela cuida → Se a tela buggar ou alguém editar direto na base, risco continua.
- **Recomendação:** Opção 1 + 2: a tela não deixa vazio, AND o sistema por tras valida. Dupla segurança.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:143-151 (usa depositos[0] se deposito_id=null, pode ser wrong warehouse)

## P094 — Sua conta MercadoLivre fica desconectada porque o sistema não guardou a autorização renovada
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Integração com MercadoLivre (Autenticação + Sincronização de Anúncios)
- **Imagina assim:** Você conecta uma conta do MercadoLivre. O ML manda uma nova chave de acesso. O sistema recebe, mas falha ao salvar no banco de dados (internet desconecta, servidor cai, etc.). A nova chave nunca é gravada.
- **Hoje:** ML envia uma chave nova. Sistema tenta gravar no banco, mas falha silenciosamente (linha 320-331 não trata o erro). Continua como se tivesse guardado. Próxima vez que alguém tenta mexer nos anúncios, o sistema usa a chave velha, que o ML já rejeitou. ML diz 'não vale mais', e desconecta a conta.
- **Por que importa:** Sua conta fica inacessível de forma inesperada, no meio do trabalho. Anúncios não sincronizam, pedidos não entram. Você tira dúvida pensando que é problema do ML.
- **Opções:** (A) Registrar erro e mostrar alerta na tela (ex: 'Falha ao salvar, tente conectar de novo') → Operador vê aviso, reconecta imediatamente. Simples de implementar.  ·  (B) Tentar salvar de novo automaticamente, até 3 vezes com espera → Se falhou por internet instável, recupera sozinho. Menos avisos ao operador. Mais seguro.  ·  (C) Ambas: tentar de novo primeiro, se ainda falhar, mostra alerta → Melhor dos dois mundos: recuperação automática + visibilidade se persistir.
- **Recomendação:** Aplicar a opção 3 (tentar de novo + alerta). Garante que falhas temporárias se recuperam sozinhas, e problemas reais são notificados.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ml-oauth.ts:320-332

## P095 — Kit novo com 1 componente sem mapeamento
- [ ] **vou fazer** · gravidade: grave · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Produto tipo kit (KIT-TURBO) com 2 peças: TURBO-BASE e PARAFUSO-RARO. A TURBO-BASE está cadastrada no seu mapeamento, mas PARAFUSO-RARO não encontra correspondência.
- **Hoje:** Quando você sincroniza com a loja Tiny, o sistema monta o kit com só 1 das 2 peças. A outra fica perdida no caminho — o kit fica incompleto.
- **Por que importa:** Se alguém encomendar esse kit, o estoque vai achar que tem quantidade diferente do que realmente precisa. Separa 1 peça quando deveria separar 2. Pedido sai incompleto pro cliente ou sistema vai achar que tem peça em falta quando não tem.
- **Opções:** (A) Deixar como está (monta kit incompleto) → Pedidos saem faltando peça e voltam. Cliente reclama, custo de reenvio.  ·  (B) Parar a sincronização e avisar ao operador qual peça está faltando no cadastro → Operador completa o mapeamento, depois sincroniza tudo correto. Demanda 2 minutos agora, evita problema depois.  ·  (C) Trazê-lo automaticamente com número genérico pra depois operador revisar → Kit sincroniza, fica marcado pra revisão. Menos disruptivo, mas cria fila de revisão.
- **Recomendação:** Parar e avisar ao operador. Assim você não deixa kit quebrado no sistema.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

## P096 — Imagens apagadas no Tiny (produto tinha 3, agora tem 0)
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Produto DISCO tinha 3 fotos. Alguém no Tiny apaga todas. Operador clica sincronizar.
- **Hoje:** O sistema limpa as 3 imagens da base. Mas ao mesmo tempo, guarda uma referência velha apontando pra uma foto que já não existe. Duas tabelas ficam desincronizadas — uma vazia, outra apontando pra nada.
- **Por que importa:** Quando alguém tentar carregar a página do produto (na loja ou no app), vai tentar mostrar foto de um link quebrado. Sistema fica confuso sem saber se existe imagem ou não.
- **Opções:** (A) Deixar como está (duas tabelas em desacordo) → Relatórios de produto retornam dados conflitantes. Foto não abre mas sistema acha que existe.  ·  (B) Quando limpar as imagens, limpar também a referência antiga → Dados ficam consistentes. Se Tiny diz 'sem fotos', você limpa tudo mesmo.  ·  (C) Pedir confirmação ao operador antes de apagar imagens → Operador decide se foi acidente ou intencional. Mais seguro, menos automático.
- **Recomendação:** Limpar também a referência antiga. Quando você sincroniza, todas as duas tabelas devem ficar iguais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

## P097 — Kit com 0 componentes (tipo=K mas vazio em Tiny)
- [ ] **vou fazer** · gravidade: grave · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** No Tiny, você marca um produto como 'kit' mas não adiciona nenhuma peça dentro dele. Sistema traz vazio.
- **Hoje:** O sistema marca que é kit, mas a lista de peças fica vazia. Quando alguém encomendar esse 'kit', fica um fantasma — item órfão que não se conecta a nada.
- **Por que importa:** Pedido não consegue se expandir em componentes. Estoque fica confuso: o produto existe na lista de itens mas não existe na realidade (porque não tem componente nenhum).
- **Opções:** (A) Deixar passar (kit vazio entra no sistema) → Pedidos com kit vazio não separam nada. Operador precisa descobrir que está 'faltando' toda peça (confuso).  ·  (B) Bloquear na sincronização e avisar que precisa adicionar peças antes → Força você a ter kit completo. Evita pedido com item fantasma.  ·  (C) Sincronizar mas marcar como 'suspeito' pra revisão manual → Entra, mas fica sinalizado. Alguém revisa antes de vender.
- **Recomendação:** Bloquear e avisar. Kit precisa ter pelo menos 1 peça, senão é defeito no cadastro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

## P098 — Produto perde mapeamento (empresa desativa, referência deletada)
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Sua conexão com o Tiny (a empresa/conta no Tiny) é desativada, deletada ou a referência entre suas bases é apagada. Operador clica sincronizar.
- **Hoje:** Sistema avisa no log que houve problema, mas não para: continua como se tudo estivesse ok. Operador vê 'sucesso' na tela e acha que sincronizou, mas nada foi sincronizado. Fica sem avisar claro que houve problema.
- **Por que importa:** Operador acha que sincronizou mas não sincronizou. Estoque em você e estoque no Tiny ficam desincronizados sem ninguém saber. Próximo pedido vem com dados antigos ou perdidos.
- **Opções:** (A) Deixar como está (silencioso, aparenta sucesso) → Operador não vê problema, ninguém sabe que estoque está desincronizado até cliente reclamar.  ·  (B) Mostrar erro vermelho ao operador explicando que mapeamento foi perdido → Operador vê, restaura mapeamento ou investiga. Problema fica visível imediato.  ·  (C) Pausar sincronização até mapeamento ser restaurado → Força ação. Mais robusto mas pode ser chato se problema é menor.
- **Recomendação:** Mostrar erro claro. Nunca sincronize silenciosamente com problema de mapeamento.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

## P099 — Duplo clique no recebimento (mesma NF, lote, itens)
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Entrada de estoque — como o sistema registra quando mercadoria chega
- **Imagina assim:** Operador clica 2x rápido em 'enviar recebimento' — a comunicação enviada 2x com mesmo conteúdo
- **Hoje:** Primeira chamada cria movimento e lote com ID aleatório. Segunda chamada gera NOVO ID (pois é gerado aleatoriamente novamente), cria 2º movimento idêntico. Banco aceita ambos como registros diferentes. Estoque fica duplicado.
- **Por que importa:** Balanço fico errado. Se chegaram 100 unidades, sistema acha que chegaram 200. Auditoria não consegue rastrear.
- **Opções:** (A) Congelar botão até resposta chegar (proteção básica) → Operador não consegue clicar 2x. Solução rápida, 2-3 dias.  ·  (B) Usar assinatura fixa da nota fiscal como ID em vez de gerar aleatório → Mesmo que clique 2x, segunda chamada é reconhecida como duplicata e rejeitada. Mais robusto, mais trabalho.
- **Recomendação:** Congelar botão agora (rápido), depois refatorar pra assinatura fixa (melhor controle).
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:98

## P100 — Quando duas compras chegam em preços diferentes, o custo fica errado
- [ ] **vou fazer** · gravidade: grave · tema: Custo e preço das peças · fluxo: Custo médio do produto
- **Imagina assim:** Você já tinha 10 unidades de um produto a R$ 15,50 cada. Chega uma segunda compra: 5 unidades a R$ 20,00 cada.
- **Hoje:** O sistema calcula a média corretamente no papel: (10 × 15,50 + 5 × 20) ÷ 15 = R$ 17,00. Mas o sistema só lembra dessa média — não acompanha que você pode ter vendido 2 unidades entre a primeira e segunda compra. Se vendeu, a conta estava errada desde o começo.
- **Por que importa:** O custo registrado é usado para calcular quanto você ganhou em cada venda. Se está errado, seus lucros no relatório não batem com a realidade. Você acha que ganhou menos (ou mais) do que realmente ganhou.
- **Opções:** (A) Refazer todas as contas do começo (do dia que o produto entrou no estoque) → Custoso, mas fica 100% correto. Muito lento pra fazer toda hora.  ·  (B) Deixar como está, mas avisar no relatório que esse custo pode estar aproximado → Rápido, mas você nunca sabe se o custo é de verdade ou só um palpite.
- **Recomendação:** Parar de guardar só o custo final. Guardar também cada compra com seu custo separado e data. Quando precisa saber o custo, recalcular só aquilo que foi vendido desde cada compra. Mais trabalho no código, mas fica certo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260520b_rpc_inserir_movimentacao.sql:104

## P101 — Descobrir uma compra de 3 meses atrás desfaz o custo de tudo
- [ ] **vou fazer** · gravidade: grave · tema: Custo e preço das peças · fluxo: Custo médio do produto
- **Imagina assim:** Em março, você recebeu 5 unidades a R$ 12,50 cada. Ninguém registrou no sistema. Você descobre em junho e digita manualmente: chegou em março, era 5 unidades, R$ 12,50 cada.
- **Hoje:** O sistema pega o saldo que você TEM HOJE (por exemplo, 20 unidades em junho) e refaz a conta como se essa compra de março fosse a mais recente. Resultado: calcula um custo médio que mistura produtos de março com produtos que você já vendeu entre março e junho. Fica completamente errado.
- **Por que importa:** Se você descobre que faltou registrar compras antigas, o sistema não consegue corrigir. O custo fica bagunçado pra frente.
- **Opções:** (A) Quando você digita uma compra atrasada, o sistema avisa que vai recalcular tudo e você confirma → Seguro — você sabe que algo mudou. Mas pode ser lento se tiver muitas compras.  ·  (B) Não permitir registrar compras anteriores a um certo período (por exemplo, últimos 30 dias) → Evita o problema, mas você fica travado se descobrir uma compra antiga de verdade.
- **Recomendação:** Refazer a fórmula do custo médio passo a passo, respeitando datas (tipo um filme: março acontece, depois cada venda de abril, depois cada entrada de maio...). Mas só fazer isso quando alguém registra uma compra retroativa — do dia a dia, deixa rápido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260526_custo_medio_ajuste_manual.sql:178-206

## P102 — Desfazer uma entrada não corrige o custo
- [ ] **vou fazer** · gravidade: grave · tema: Custo e preço das peças · fluxo: Custo médio do produto
- **Imagina assim:** Você recebeu 10 unidades a R$ 15,50 cada. Anotou errado — não eram 10, era 5. Clica 'desfazer' essa entrada.
- **Hoje:** O sistema remove as 10 unidades do saldo — volta a zero. Mas o custo R$ 15,50 fica gravado como se ainda tivesse o produto. Se depois você recebe 5 unidades de novo a R$ 20, a conta da média fica estranho (mistura um saldo que sumiu com um saldo novo).
- **Por que importa:** Você fica com um 'custo fantasma': o sistema lembra de um preço de um produto que não existe mais no estoque. Depois quando compra de novo, a conta fica torta.
- **Opções:** (A) Voltar o custo pro valor antes dessa entrada chegar → Correto e seguro. Você volta pra situação anterior.  ·  (B) Deixar o custo em branco (nenhum custo) quando saldo fica zero → Limpo, mas você perde a história de quanto custava antes.
- **Recomendação:** Opção 1: guardar qual era o custo antes da entrada, e voltar pra ele quando desfaz. Mais simples que parece.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:363-417

## P103 — Produto grátis ou devolvido não baixa o custo
- [ ] **vou fazer** · gravidade: grave · tema: Custo e preço das peças · fluxo: Custo médio do produto
- **Imagina assim:** Cliente devolveu 5 unidades de um produto. Você digita na devolução: 5 unidades, custo zero (devolvidas). Você já tinha 10 unidades a R$ 15,50 cada.
- **Hoje:** O sistema recebe 5 unidades de custo zero. Mas como o custo é zero, acha que é inválido e ignora. O saldo sobe pra 15 unidades, mas o custo médio continua R$ 15,50 — como se todas as 15 fossem caras. Deveria ser (10 × 15,50 + 5 × 0) ÷ 15 = R$ 10,33.
- **Por que importa:** Você está inflando o custo. Parece que o produto é mais caro do que realmente é. Lucro aparenta ser menor.
- **Opções:** (A) Aceitar custo zero e recalcular a média automaticamente → Correto — R$ 10,33 no exemplo. Você vê o custo real.  ·  (B) Colocar um custo mínimo (R$ 0,01) pra evitar zero → Funciona, mas é gambiarrinha — o preço de verdade ainda é zero.
- **Recomendação:** Opção 1: aceitar custo zero se o motivo for devolução ou achado, e refazer a conta normalmente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260520b_rpc_inserir_movimentacao.sql:89

## P104 — Valor das mercadorias novas aparece zerado no relatório
- [ ] **vou fazer** · gravidade: grave · tema: Custo e preço das peças · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Uma compra chega com 50 unidades de um produto novo. O sistema não tem preço registrado ainda.
- **Hoje:** O relatório mostra 50 unidades entradas, mas valor total = 0,00 reais. Porque o sistema multiplica quantidade × (preço vazio), e vazio = zero.
- **Por que importa:** Você quer saber quanto em reais entrou de estoque. Com valor zerado, você não consegue reconciliar com a nota fiscal do fornecedor nem saber se gastou 500 reais ou 5.000 reais. Auditoria fica cega.
- **Opções:** (A) Forçar preço na entrada: não deixar registrar compra sem preço unitário → Relatório sempre mostra valor correto. Mas exige trabalho extra na hora da entrada — não pode deixar em branco.  ·  (B) Buscar preço automático: quando entra mercadoria, sistema consulta preço médio que esse produto já teve em compras anteriores → Valor fica mais completo. Mas se produto é novo (sem histórico), continua zerado. Precisa lógica para produto novo.  ·  (C) Permitir que edite depois: aceita entrada com preço vazio, mas deixa campo editável no relatório antes de exportar → Flexível para entrada rápida. Mas exige uma ação manual depois — se esquecer, continua errado.
- **Recomendação:** Opção 1 ou 2: forçar preço na entrada, com fallback para preço médio histórico. Não deixa nenhuma mercadoria entrar sem preço. Relatório limpo desde o começo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/relatorios/movs-por-empresa/route.ts:93

## P105 — Relatório demora porque puxa dados desnecessários antes de filtrar
- [ ] **vou fazer** · gravidade: grave · tema: Relatórios e indicadores · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Você consulta movimentações de 29 meses (janeiro 2024 até junho 2026) — 43 mil registros.
- **Hoje:** O sistema busca TODOS os 43 mil registros no banco de dados, depois na memória do servidor filtra só pelo período que você pediu. Se tiver muita movimentação, pode travar ou usar memória demais.
- **Por que importa:** Se o relatório travar ou ficar lento quando você pede um período grande, fica improdutivo consultar movimentações antigas. Cada consulta pode levar minutos.
- **Opções:** (A) Limitar período automático: quando você abre o relatório, já vem com 'últimos 12 meses' pré-selecionado → Primeiro acesso rápido. Se quiser período maior, clica em 'carregar' e sabe que vai demorar. Controle nas suas mãos.  ·  (B) Paginação: relatório traz 5 mil registros por página, com botão 'próxima página' → Sempre rápido. Você navega pelos dados em pequenos lotes. Mais profissional.  ·  (C) Nada muda: deixa como está, qualquer período pode demora → Simples para o programador agora. Mas você sofre quando tenta auditar período grande — vai levar tempo ou ficar lento.
- **Recomendação:** Opção 1 + 2: padrão de últimos 12 meses na entrada, e se quiser mais, oferece paginação de 5 mil registros por página. Relatório sempre responsivo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/relatorios/movs-por-empresa/page.tsx:54-57

## P106 — A mesma mercadoria pode ser 'cancelada' duas vezes
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Uma movimentação de entrada é cancelada (registrada uma saída que desfaz a entrada). Se por algum motivo o cancelamento for feito duas vezes, o sistema não bloqueia.
- **Hoje:** Primeira tentativa de cancelamento: sistema registra saída que anula a entrada. Segunda tentativa: não há aviso de erro, o sistema aceita uma segunda saída anulando a entrada novamente. Saldo fica errado.
- **Por que importa:** Se você clica em 'cancelar' duas vezes por engano (ou o sistema retenta automaticamente), a movimentação fica contada errado — você perde rastreabilidade de quanto entrou de verdade.
- **Opções:** (A) Bloqueio no banco de dados: constraint que não permite dois cancelamentos da mesma entrada → Proteção automática. Se tentar cancelar duas vezes, banco rejeita com erro. Confiável.  ·  (B) Validação no código: antes de registrar cancelamento, verifica se já existe um cancelamento dessa entrada → Proteção em software. Precisa ser testada e mantida, mas flexível se regras mudarem.  ·  (C) Sem bloqueio: deixa como está, confia que usuário não vai clicar duas vezes → Nenhuma proteção. Um clique duplo ou retry automático causam duplicação de cancelamento.
- **Recomendação:** Opção 1: constraint UNIQUE no banco de dados. Garante que nenhuma entrada tenha dois cancelamentos, blindado contra erros de código ou clique duplo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/relatorios/movs-por-empresa/route.ts:53

## P107 — Sistema puxa todos os dados e depois filtra no servidor (ineficiente)
- [ ] **vou fazer** · gravidade: grave · tema: Relatórios e indicadores · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Você consulta movimentações de uma empresa específica, e o sistema tem dados de 5 empresas. Para um período de 12 meses com ~1.500 movimentações/mês = 18 mil registros.
- **Hoje:** Sistema puxa os 18 mil registros do banco de dados (todas as empresas), depois filtra em memória do servidor para mostrar só os da empresa que você pediu. Descarta 90% do que trouxe.
- **Por que importa:** Desnecessário carregar dados de outras empresas na memória e depois jogar fora. Relatório fica lento e consome mais recursos de servidor — quanto mais empresas tiver, pior fica.
- **Opções:** (A) Mover filtro para banco: SQL já retorna só os registros da empresa que você quer → Muito mais rápido. Traz só os 2 mil registros relevantes, ignora os 16 mil desde o começo. Profissional.  ·  (B) Deixar como está: continua trazendo tudo e filtrando em memória → Funciona, mas lento. Cada consulta traz dados desnecessários. Pior conforme crescer número de empresas.  ·  (C) Documentar a limitação: avisar que período deve ser pequeno (máx 1-2 meses) para não ficar lento → Trabalho-torno. Usuário fica frustrado ao ter que consultar mês por mês em vez de semestre inteiro.
- **Recomendação:** Opção 1: colocar filtro de empresa no SQL. Relatório fica rápido e escalável, independente de quantas empresas tiver.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/relatorios/movs-por-empresa/route.ts:62, 82-83

## P108 — Custo fica zerado quando produto recebe ajuste sem valor
- [ ] **vou fazer** · gravidade: grave · tema: Custo e preço das peças · fluxo: Relatório de Custo Médio dos Produtos
- **Imagina assim:** Produto DEF: chega entrada de 10 unidades a 5 reais cada (custo médio vira 5). Depois o sistema registra uma saída de 10 unidades (saldo vira zero). Depois chega outra entrada: 5 unidades, mas dessa vez com custo zero (um achado ou ajuste manual sem valor). O custo médio cai pra zero.
- **Hoje:** O sistema recalcula o custo médio usando a fórmula: (quantidade_anterior × custo_anterior + quantidade_nova × custo_novo) / quantidade_total. Com 0 × 5 + 5 × 0 = 0, o custo fica zerado mesmo tendo 5 unidades no estoque.
- **Por que importa:** Se o custo fica zerado mas tem mercadoria no estoque, o valor financeiro total do seu estoque vira zero nas planilhas de custo — parece que aquele produto não vale nada, quando na verdade vale. Isso quebra seus relatórios de quanto você gastou.
- **Opções:** (A) Bloquear entradas com custo zero → Garante que nenhum produto com estoque fique com custo zerado. Precisa que alguém (fornecedor ou ajuste) sempre diga um custo. Mais rigoroso.  ·  (B) Aceitar, mas avisar que custo ficou zero → Deixa flexível pra casos raros (achados, doações). Mas o usuário precisa saber que o custo está vazio na tela — senão pensa que o produto desapareceu do relatório.
- **Recomendação:** Bloquear entrada com custo zero quando quantidade > 0. Se é um achado de verdade, registra custo mínimo (0.01 ou o menor custo histórico do produto). Evita surpresas nos relatórios financeiros.
- **➡️ MINHA ESCOLHA:** 
- **Código:** migration 20260520b_rpc_inserir_movimentacao.sql:103-110

## P109 — Mesmo pedido entra duas vezes no sistema, dobrando o estoque
- [ ] **vou fazer** · gravidade: grave · tema: Recebimento e guarda de mercadoria · fluxo: Relatório de Custo Médio dos Produtos
- **Imagina assim:** Nota fiscal 12345 chega e o computador envia dois avisos (quando entra um pedido) para guardar mercadoria. O sistema processa as duas mensagens. Entra 10 unidades, mas o registro mostra 20 unidades a mais (e o custo médio é calculado duas vezes).
- **Hoje:** Se o mesmo aviso da loja vem duas vezes (falha de conexão, envio repetido), o sistema insere duas movimentações completamente iguais — cada uma com código único, mas com os mesmos dados. Estoque cresce 20 em vez de 10, custo médio recalculado duas vezes. Ficam dois registros no histórico.
- **Por que importa:** Você recebe mercadoria uma vez só, mas o sistema registra duas. No final do mês, o saldo no sistema não bate com a mercadoria de verdade na prateleira — você acha que tem 20 camisetas quando só chegaram 10. Auditorias e acertos de estoque ficam muito mais difíceis.
- **Opções:** (A) Sistema bloqueia se nota fiscal já foi recebida → Recebe aviso repetido, detecta que nota 12345 já existe, descarta o segundo. Limpo, automático, sem falhas.  ·  (B) Quem chama o sistema (integrador) deve garantir que não repete → Responsabilidade fica com quem manda os avisos (Tiny, marketplace). Frágil — se eles falharem, você tem duplicata no seu sistema.
- **Recomendação:** Sistema deve bloquear: antes de registrar uma movimentação de entrada, verifica se essa nota fiscal + produto já foi registrado. Se sim, descarta (ou retorna 'já foi'). Protege você contra falhas do integrador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ledger.ts:179-206

## P110 — Estorno de mercadoria não reverte o custo médio — fica inflado
- [ ] **vou fazer** · gravidade: grave · tema: Custo e preço das peças · fluxo: Relatório de Custo Médio dos Produtos
- **Imagina assim:** Entrada de 10 camisetas a 8 reais cada (custo médio sobe para 8). Depois você devolve as 10 camisetas (estorno). O custo médio continua em 8, mesmo sem mercadoria.
- **Hoje:** Quando você estorna uma entrada, o sistema insere um registro de devolvimento (tipo estorno). Mas não recalcula o custo médio — ele fica congelado no valor antigo (8). Saldo volta a zero, mas custo permanece em 8. Se depois entra nova mercadoria, o custo recalcula com esse 8 antigo ainda no meio.
- **Por que importa:** Seu custo médio fica artificialmente alto depois de estornos. Se você tinha custo 8, devolveu tudo, e depois recalcula com outro custo novo, o cálculo inclui um custo de mercadoria que você não tem mais. O resultado: seus insights financeiros (quanto você gastou em estoque) ficam inflados.
- **Opções:** (A) Estorno recalcula o custo como se entrada nunca tivesse existido → Se tinha custo 5, entrou a 8 (virou 8), estorna (volta pra 5). Custo histórico fica correto. Mais lógico.  ·  (B) Estorno só registra a saída, custo congelado → Mais rápido para processar. Mas deixa custo antigo 'flutuando' — precisa avisar operador que custo é histórico, não vigente.
- **Recomendação:** Estorno deve recalcular custo médio para trás (desfaz o efeito da entrada). Se entrada original foi E 10@8, estorno S 10 volta o custo pro valor antes da entrada. Dados financeiros ficam reais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** migration 20260520b_rpc_inserir_movimentacao.sql:107-108, 152-159

## P111 — Sistema mostra 20 unidades de um produto, Tiny mostra 30 — perdi 10 na conta
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Conferência de estoque entre WMS e Tiny
- **Imagina assim:** SKU mapeado entre WMS (sistema seu) e Tiny (plataforma de vendas)
- **Hoje:** Você vê no relatório de reconciliação que um produto tem 20 unidades no seu sistema mas 30 em Tiny. A diferença = -10. Exemplo: Produto "Parafuso M4", você contou 20 peças, Tiny mostra 30. Três causas possíveis: (1) você vendeu 10 peças em Tiny mas o aviso não chegou ao seu sistema; (2) Tiny recebeu 10 peças de um fornecedor mas seu sistema ainda não viu; (3) alguém adicionou 10 peças direto em Tiny sem avisar você.
- **Por que importa:** Se não resolver, você anuncia 20 peças pra vender, cliente compra 15 — sobram só 5. Vende mais do que tem. Promessa não cumprida = cliente insatisfeito, devolução, prejuízo.
- **Opções:** (A) Esperar 1 hora (se foi sincronização atrasada, resolve sozinha) → Sem trabalho agora, mas pode dar falsa sensação de segurança se a falha for real.  ·  (B) Corrigir manualmente no seu sistema — digitar que são mesmo 30 (ou quanto acredita ser o valor certo) → Rápido, mas se foi aviso atrasado, você errou de novo e piora a bagunça.  ·  (C) Corrigir em Tiny (se entende que Tiny está errado) → Só faz sentido se você tem certeza de onde está o erro. Depois sincronizar.
- **Recomendação:** Revise com seu comprador ou gerente de Tiny: foi entrada de compra, saída de venda ou ajuste manual? Só depois corrija onde foi o erro, não nos dois lados.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reconciliacao-tiny.ts:110-128; ledger.ts:44-63

## P112 — Relatório só mostra os primeiros 50 produtos — os outros 150 não aparecem
- [ ] **vou fazer** · gravidade: grave · tema: Relatórios e indicadores · fluxo: Conferência de estoque entre WMS e Tiny
- **Imagina assim:** Sua empresa tem 200 produtos mapeados entre seu sistema e Tiny
- **Hoje:** O relatório de sincronização roda, mas só analisa os primeiros 50 (ou 100, dependendo da configuração). Se o produto #101 tem problema de sincronização, você nunca vê — parece que está tudo certo, mas não está. Exemplo: "Parafuso M4" é o produto #103, tem diferença de -5 peças. Relatório só analisa até #50. Você acha que está tudo sincronizado, mas na verdade perdeu 5 peças.
- **Por que importa:** Problemas escondidos virão à tona só quando vender demais ou falar com cliente. Quando é tarde.
- **Opções:** (A) Aumentar limite para 500 — analisa todos na primeira rodada → Rápido se não tiver muitos produtos. Relatório fica lento se tiver milhares.  ·  (B) Adicionar aviso visual — 'Atenção: analisamos 50 de 200. Aumentar?' — operador escolhe → Operador sabe que está vendo só um pedaço. Escolhe aumentar se achar necessário.  ·  (C) Paginar — relatório mostra 50, depois 'Próxima página', sempre mostrando qual é o total → Mais trabalho pro operador, mas vê tudo eventualmente.
- **Recomendação:** Começar com aviso: 'Analisamos X de Y produtos'. Assim operador sabe que não viu tudo e pode pedir mais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reconciliacao-tiny.ts:70-76; page.tsx:74

## P113 — Alguém tira o código de uma prateleira enquanto o operador está contando
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Criar, editar e remover prateleiras
- **Imagina assim:** Operador A abre contagem da Prateleira A (o sistema marca como 'em contagem'). Operador B tenta trocar o tipo dessa prateleira (de picking para quarentena) ou apagar ela. Consegue? Não deveria.
- **Hoje:** O sistema não verifica se a prateleira está marcada como 'em contagem' quando alguém tenta mudar o tipo ou deletar. O operador B consegue fazer a mudança enquanto A está contando — a prateleira muda de tipo no meio do inventário.
- **Por que importa:** Se o operador A está contando 500 unidades e, no meio, o tipo da prateleira muda (de picking para quarentena), ele fica confuso: a prateleira sai da zona de picking onde ele estava procurando. Gera discrepância no inventário.
- **Opções:** (A) Bloquear completamente — se está em contagem, ninguém mexe → Seguro, mas operador que abriu contagem errado precisa cancelar pra alguém consertar  ·  (B) Apenas avisar ao deletar, permitir trocar tipo → Flexível, mas risco de confusão continua — tipo mudou sem o contador saber
- **Recomendação:** Bloquear — se tem contagem ativa, não deixa mudar tipo nem apagar a prateleira. Mensagem: 'Prateleira está sendo contada. Aguarde terminar a contagem.'
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/localizacoes/[id]/route.ts

## P114 — Prateleira de recebimento usada errado na separação
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Importação em lote de prateleiras
- **Imagina assim:** Operador cria um lote de prateleiras marcando 5 como 'tipo recebimento'. Depois, ao separar um pedido, o sistema tira produtos exatamente dessa prateleira de recebimento.
- **Hoje:** Nada bloqueia. Sistema deixa separar de onde não deveria — prateleira de recebimento é só pra guardar produtos que chegam.
- **Por que importa:** Confunde o operador, mistura fluxos. Produto que deveria estar em quarentena aparece no pedido. Separa a partir de prateleira errada.
- **Opções:** (A) Adicionar validação no sistema — quando rotear pedido, filtrar só prateleiras tipo picking → Erros bloqueados na raiz, operador não consegue errar  ·  (B) Avisar operador na hora da criação — mostrar que essa prateleira não serve pra separação → Operador sabe antes, mas ainda consegue tentar errar depois
- **Recomendação:** Opção A — bloqueia na raiz, sem depender do operador se lembrar
- **➡️ MINHA ESCOLHA:** 
- **Código:** roteamento.ts — buscarLinha() não filtra por tipo

## P115 — Prateleira desbloqueada com estoque pendente (reserva expirada)
- [ ] **vou fazer** · gravidade: grave · tema: Estoque apartado pros pedidos (reservas) · fluxo: Importação em lote de prateleiras
- **Imagina assim:** Prateleira A-05 tem 50 unidades apartadas pra um pedido que venceu (expirou há 2 horas). Operador tenta desativar a prateleira.
- **Hoje:** Sistema deixa desativar. Aquelas 50 unidades ficam órfãs — o sistema não sabe mais onde estão. Desativação checa se tem saldo (quantidade visível), mas ignora o que está apartado pra pedidos vencidos.
- **Por que importa:** Perda de rastreabilidade. Operador acha que prateleira foi apagada, mas 50 peças sumiram. Depois fica impossível saber onde a mercadoria foi.
- **Opções:** (A) Bloquear desativação se houver estoque apartado (mesmo vencido) — sistema não deixa operador deletar → Seguro, mas pode deixar prateleira travada se apartação expirada não limpar sozinha  ·  (B) Limpar automaticamente apartações vencidas 1 hora antes — sistema solta o estoque sozinho → Prateleira libera naturalmente, operador consegue desativar depois
- **Recomendação:** Opção B — mais operacional, solta o estoque automaticamente
- **➡️ MINHA ESCOLHA:** 
- **Código:** localizacoes.ts linha 121-133

## P116 — Operador contorna bloqueio de permissão com curl
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Importação em lote de prateleiras
- **Imagina assim:** Operador tem permissão só pra ler prateleiras, não pra criar. Botão 'Criar' aparece cinzento. Ele usa curl/Postman pra enviar comando direto ao sistema.
- **Hoje:** Sistema não valida permissão no lado do servidor — só o formulário está bloqueado. Criação funciona mesmo sem permissão.
- **Por que importa:** Brecha de segurança. Operador não-autorizado consegue criar prateleiras contornando o bloqueio visual.
- **Opções:** (A) Exigir que servidor valide quem está enviando antes de criar — checa permissão na rota → Erros bloqueados de verdade, curl também é rejeitado  ·  (B) Remover permissão de criação da base desse operador — edita no cadastro → Operador não consegue nem tentar, mas não resolve pra próximo que tentar contornar
- **Recomendação:** Opção A — conserta a raiz, bloqueia de verdade
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts linha 41 — requireAuth, não requireAdmin

## P117 — Sincronizar produto editado no fornecedor: silêncio total no sistema
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** A descrição de um produto mudou lá no fornecedor de 'Vela Branca' pra 'Vela Branca LED 8W'. Admin clica o botão de sincronizar no sistema.
- **Hoje:** Se o mapeamento entre o seu sistema e o fornecedor não está registrado, nada acontece. Nenhum erro, nenhum aviso. Admin acha que sincronizou, mas na verdade pulou.
- **Por que importa:** O descritivo do produto fica desatualizado no seu sistema, enquanto lá fora já mudou. Quando o cliente vê 'Vela Branca' no seu sistema mas 'Vela Branca LED 8W' no fornecedor, fica confuso. Além disso, admin nunca sabe que a sincronização não funcionou.
- **Opções:** (A) Avisar: 'Não achei o mapeamento desse produto com o fornecedor. Precisa criar manualmente antes' → Admin sabe exatamente por que não sincronizou e o que fazer.  ·  (B) Deixar silencioso (como é hoje) → Admin acha que sincronizou. Dados ficam errados. Ninguém descobre até aparecer reclamação.
- **Recomendação:** Avisar quando falhar. Crucial pra confiança no sistema. Também: mostrar diferenças antes de aplicar, tipo 'vai mudar descrição de X pra Y — OK?'
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 2 em corrigir

## P118 — Produto sem mapeamento no fornecedor: sincronização falha em silêncio
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Um produto foi criado manualmente no seu sistema, sem registro de qual fornecedor ou qual código lá fora. Admin clica sincronizar.
- **Hoje:** Sistema não acha nenhum mapeamento, loga um aviso interno e continua. Nenhuma mensagem na tela. Admin acha que sincronizou.
- **Por que importa:** Confiabilidade. Você não tem como saber se a sincronização aconteceu de verdade ou não. Se precisa importar dados do fornecedor e quer ter certeza que tudo sincronizou, é impossível descobrir quais falharam.
- **Opções:** (A) Avisar: 'Não achei o vínculo com o fornecedor. Crie o mapeamento manualmente primeiro' → Admin sabe exatamente o que fazer e por que não funcionou.  ·  (B) Bloquear o botão sincronizar pra produtos sem mapeamento → Evita confusão: admin tenta clicar e vê 'botão desativado — crie o vínculo primeiro'.  ·  (C) Deixar silencioso → Admin fica no achismo se funcionou ou não. Perda de confiabilidade.
- **Recomendação:** Opção 1 + 2 juntas. Bloqueie o botão E deixe uma mensagem explicando por quê. Melhor UX possível.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 5 em corrigir

## P119 — Deletar um produto que ainda tem estoque no galpão
- [ ] **vou fazer** · gravidade: grave · tema: Cancelar e desfazer · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Admin tá limpando o cadastro de produtos e clica deletar um que ainda tem 100 unidades em prateleira.
- **Hoje:** Sistema tenta deletar. Dependendo de como os dados tão relacionados, a gente pode perder o registro de todas as 100 unidades ou pode bloquear a deleção se o produto é componente de um kit.
- **Por que importa:** Perder o histórico é grave pra auditoria e para o balancete de inventário. Se alguém questiona depois 'cadê aquelas 100 unidades?', você não consegue rastrear. Além disso, seu histórico de movimentações fica quebrado.
- **Opções:** (A) Trocar delete por desativar: produto sai da venda mas continua no banco, marcado como 'inativo desde X' → Histórico intacto. Auditoria feliz. Você consegue recuperar se precisar. Ninguém consegue 'perder' um produto.  ·  (B) Deixar deleção real → Rápido de limpar o cadastro visualmente. Mas se aparecer discrepância depois, a informação desapareceu — sem volta.
- **Recomendação:** Desativar obrigatoriamente. Não é negociável pra qualquer negócio que precisa de auditoria. Bloqueia a deleção no código mesmo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 6 em corrigir

## P120 — Kit criado vazio não funciona
- [ ] **vou fazer** · gravidade: grave · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Produtos que são feitos de componentes (Kits)
- **Imagina assim:** Operador marca um produto como kit, mas não coloca nenhum componente dentro
- **Hoje:** Quando um pedido chega com esse kit, o sistema aceita, expande para nada, e depois tenta apartar estoque de algo que não existe
- **Por que importa:** Um kit vazio é como pedir uma caixa com 0 itens — o operador pensa que tá tudo ok, mas na hora de separar não tem nada pra guardar e o pedido fica preso
- **Opções:** (A) Validar ao criar/editar o kit no cadastro → Impede kit vazio desde o início; mais caro fazer, mas zero pedidos com problema  ·  (B) Validar apenas quando o pedido chega (aviso da loja) → Deixa cadastro solto, mas rejeita pedido — operador vê erro, volta atrás  ·  (C) Deixar como está → Continua falhando silenciosamente; pedidos e estoque ficam confusos
- **Recomendação:** Fazer bloqueio no cadastro. Se alguém marca kit=verdadeiro, não deixa salvar enquanto tiver 0 componentes.
- **➡️ MINHA ESCOLHA:** 
- **Código:** webhook-processor-wms.ts:222-228

## P121 — Quantidade negativa ou zero em componente do kit
- [ ] **vou fazer** · gravidade: grave · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Produtos que são feitos de componentes (Kits)
- **Imagina assim:** Operador tenta adicionar um componente com quantidade 0, -1, ou vazio
- **Hoje:** Código tem validação só no servidor e só lança erro (código 500 genérico); a tela não avisa antes de enviar
- **Por que importa:** Um kit com parafuso de -5 unidades não faz sentido; quebra o cálculo de quantos kits estão disponíveis
- **Opções:** (A) Bloquear só na tela (não deixa digitar quantidade ≤0) → Mais rápido, mas se alguém burlar, servidor retorna erro confuso  ·  (B) Bloquear na tela E retornar mensagem clara do servidor → Dupla proteção; operador vê aviso legível  ·  (C) Deixar como está → Erro 500; operador tira print, manda pra TI, ninguém sabe o que aconteceu
- **Recomendação:** Opção 2 — validar nos dois lugares. Tela avisa ali mesmo; se vier solicitação estranha, servidor devolve código 400 com mensagem tipo 'quantidade deve ser ≥ 1'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:72; kits.ts:217-219

## P122 — Produto que é um pacote (kit) — histórico desaparece
- [ ] **vou fazer** · gravidade: grave · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Um operador bipou um kit (pacote com 3 itens dentro). Sistema expandiu pra contar cada peça separadamente
- **Hoje:** Histórico mostra contagens das 3 peças soltas, mas não mostra a contagem original do pacote. Se você volta e procura 'quantas vezes contei o pacote', não acha registro
- **Por que importa:** Auditoria fica confusa — parece que o pacote nunca foi contado, só as peças. Faz duvidar da contagem
- **Opções:** (A) Gravar no histórico: contagem 1 do kit + contagem 1 de cada peça (3 linhas no histórico) → Auditoria completa, mas pode confundir (parece 4 contagens em vez de 1)  ·  (B) Gravar só do kit no histórico, expandir pra peças só na hora de calcular divergência → Histórico fica limpo, mas mais lógica de cálculo  ·  (C) Não permitir contar kits — obrigar a contar peça por peça → Sem surpresas, mas mais lento pra operador
- **Recomendação:** Opção 1: gravar kit + peças no histórico, mas deixar claro visualmente que é 1 bipe expandido em 3. Auditoria honesta
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/inventario.ts:522-552

## P123 — Clique duplo causa contagem errada
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Auto-cadastro de fornecedores
- **Imagina assim:** Operador clica 'Auto-cadastrar mapeamento canônico' e imediatamente clica de novo antes da resposta voltar
- **Hoje:** Dois avisos chegam ao mesmo tempo tentando cadastrar o mesmo fornecedor. O primeiro acha que não existe e cria. O segundo também acha que não existe (porque verificou ao mesmo tempo) e tenta criar. Um consegue, o outro recebe erro. Mas o sistema só conta o que conseguiu. Resultado: um clique diz "1 criado", o outro diz "0 criado", mesmo tendo criado só 1 de verdade.
- **Por que importa:** Operador não sabe se o fornecedor foi realmente criado ou não. Fica confuso. Pode tentar de novo achando que não funcionou, ou parar achando que funcionou quando não foi.
- **Opções:** (A) Deixar o registro de dados garantir que só um consegue inserir (gravar ou atualizar) → Mais rápido, confiável. Um aviso cria, o outro vê que já existe e pronto. Contagem fica correta pros dois.  ·  (B) Usar travamento (travar a linha no registro antes de verificar) → Funciona, mas mais lento. Enquanto um está processando, o outro espera.  ·  (C) Aceitar que acontece e fazer o operador recarregar a lista depois → Operador vê a lista desatualizada por alguns segundos. Depois carrega correto. Simples mas fica confuso no momento.
- **Recomendação:** Gravar ou atualizar direto. É o jeito mais rápido e confiável. O registro de dados já faz isso bem em outros lugares do código.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/fornecedores.ts:345-351

## P124 — Quando marca um fornecedor como preferencial, outro pode ficar sem ser desativado corretamente
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Produto P123 tem 3 fornecedores: F1 (preferencial), F2 e F3. Você quer marcar F2 como preferencial. O sistema deveria desativar F1 automaticamente, mas em alguns casos ele pode deixar dois marcados como preferenciais ao mesmo tempo.
- **Hoje:** O sistema faz essa troca em duas etapas separadas sem proteção. Deveria fazer tudo de uma vez (tudo ou nada), mas faz primeiro uma coisa, depois outra.
- **Por que importa:** Se dois fornecedores ficar marcados como preferenciais, o sistema fica confuso sobre qual é realmente o principal pra pedir. Isso pode virar pedidos duplicados ou devolvidas erradas.
- **Opções:** (A) Travar o registro enquanto faz a mudança → Garante que ninguém mais mexe enquanto o sistema está atualizando. Mais seguro, um pouco mais lento.  ·  (B) Usar uma regra no banco que só permite 1 preferencial por produto → O banco automaticamente rejeita a segunda requisição. Muito seguro, não precisa de código especial.
- **Recomendação:** Use a regra no banco. É mais simples e o banco já sabe fazer isso bem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/produto-fornecedores/[id]/route.ts:66-78

## P125 — Dois cliques muito rápidos no mesmo fornecedor preferencial causam confusão
- [ ] **vou fazer** · gravidade: grave · tema: Compras de fornecedor · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Você abre a tela de fornecedores em duas abas do navegador. Na aba 1 marca F10 como preferencial de P111. Ao mesmo tempo (aba 2), marca F11. Os dois cliques chegam ao sistema quase juntos.
- **Hoje:** O sistema processa os dois ao mesmo tempo, sem saber um do outro. Resultado: final ganha quem foi último. No caso, F11 fica marcado, F10 fica desmarcado. Tecnicamente funcionou mas foi por sorte, não por design.
- **Por que importa:** Seu sistema não está protegido contra isso. Se você clicar 2x rápido na mesma ação (ou em abas diferentes), pode ficar inconsistente. Hoje funciona por acaso. Amanhã pode quebrar.
- **Opções:** (A) Desabilitar o botão enquanto processa (navegador) + travar no banco → Proteção dupla. Seu navegador não deixa clicar 2x, e o banco também defende. Mais robusto.  ·  (B) Deixar como está e contar com que ninguém clica 2x muito rápido → Funciona hoje, mas é risco. Usuário rápido, rede lenta, qualquer coisa quebra a suposição.
- **Recomendação:** Use proteção dupla. Custa pouco, evita dor de cabeça.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/produto-fornecedores/[id]/route.ts:66-81

## P126 — Inventário trancado há horas aparece como se fosse travado agora
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** Operador faz inventário em uma prateleira às 09h. Termina às 09:50, mas quando tenta confirmar, o sistema falha. O bloqueio fica preso no sistema. Uma hora depois, o painel mostra que a prateleira está travada há mais de uma hora, quando na verdade deveria estar desbloqueada.
- **Hoje:** Em Curitiba, hoje: o operador bloqueia a prateleira L1 às 09h para contar. Termina às 09:50, o sistema tenta desbloquear mas falha. Às 10:55, o painel mostra 'Prateleira travada > 1 hora: 1' quando na verdade foi desbloqueada ou deveria estar. Se outro operador tentar inventário na mesma prateleira, o sistema não deixa.
- **Por que importa:** Operador fica impedido de mexer em uma prateleira que na verdade está livre. Operações travam indefinidamente até alguém perceber e desbloquear manualmente.
- **Opções:** (A) Implementar limpeza automática: a cada 5 minutos, o sistema verifica bloqueios abertos há mais de 24 horas e fecha automaticamente, registrando quem/o quê. → Prateleiras não ficam travadas indefinidamente. Operadores podem trabalhar normalmente. Há registro de tudo.  ·  (B) Deixar como está, mas adicionar um botão no painel 'Forçar desbloqueio' para operadores experientes. → Responsabilidade humana. Rápido de arrumar quando vira problema, mas precisa de alguém supervisionando o painel constantemente.
- **Recomendação:** Implementar limpeza automática. Bloqueios é uma coisa crítica — não pode ficar na mão de vigilância humana. O sistema deve se auto-recuperar em 24 horas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** supabase/migrations/20260522_wms_roteamento.sql:66-79, src/lib/wms/dashboard-geral.ts:55-58

## P127 — Operador fica preso quando desiste de guardar no meio do caminho
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Painel de Tarefas da Guarda
- **Imagina assim:** Operador A pega um item pendente pra guardar em 2026-05-28 às 10:00. O tablet trava. Sai da tela sem confirmar. O item fica marcado como 'em_guarda' por A. No final do dia, Operador B tenta pegar o mesmo item da fila. O sistema vê que já está marcado por A e recusa — B não consegue trabalhar, item fica parado.
- **Hoje:** Sistema marca 'iniciado por Operador A às 10:00'. Quando A vai embora ou quer desistir, nunca desibilita. B vê que outro operador está mexendo (mesmo que não esteja). Clica pra pegar — erro 'já está sendo guardado por A'. Item fica travado até alguém do admin destravar manualmente.
- **Por que importa:** Se um operador sai sem confirmar (tablet trava, internet cai, cansou), todo o fluxo da guarda para naquele item. Ninguém consegue continuar trabalhando, o item não sai de RECEBIMENTO, cliente fica aguardando.
- **Opções:** (A) Tela de força-unlock: quando outro operador vê item travado, clica 'Tomar' e leva pra si → Item sai do travamento imediatamente. Operador novo continua do ponto onde A parou (guardar a quantidade restante). Mais prático.  ·  (B) Timeout automático: se não confirma em 60min, sistema reseta de 'em_guarda' pra 'pendente' → Sem intervenção, item volta pra fila automaticamente. Mas se A estava genuinamente guardando e o tablet virou de ponta-cabeça, A pode voltar em 50min e encontrar item já resgatado por B.  ·  (C) Admin destranca manualmente no painel → Resolve caso a caso. Lento. Operador fica esperando 15min til admin chegar.
- **Recomendação:** Use a opção 1 (força-unlock visível). Operador vê 'Operador Felipe começou às 10:00' e clica 'Tomar de Felipe'. Item sai do travamento ali, economia de tempo. Se preocupa que vai chacoalhar, use combo: força-unlock na UI + aviso (não automático) se > 30min.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/guarda.ts:356-371

## P128 — Relatório de estoque mostra números zerados ou desaparece
- [ ] **vou fazer** · gravidade: grave · tema: Relatórios e indicadores · fluxo: Visão de Saúde do Estoque
- **Imagina assim:** A loja está tentando ver o resumo de cobertura de estoque (aquele dashboard que mostra 'crítico', 'atenção', 'ok'), mas a tabela fica vazia ou os números não atualizam.
- **Hoje:** O operador abre a página de insights e vê 'Crítico: 0, Atenção: 0, OK: 0' ou a tabela de estoque não aparece. Na verdade, o sistema mudou a forma como guarda as informações (tirou a coluna empresa_dona_id) mas o relatório ainda está tentando ler dessa coluna antiga que não existe mais.
- **Por que importa:** Se o operador não vê o dashboard, não consegue identificar quais produtos estão com estoque crítico, quais precisam de reposição urgente. Fica cego pra falta de stock.
- **Opções:** (A) Atualizar a migração que recria o relatório (arquivo 20260605_wms_excecoes_dashboards.sql linhas 38-51) pra agrupar só por (produto, galpão) — não por empresa → Dashboard volta a funcionar, operador vê os números certos de cobertura por galpão  ·  (B) Deixar como está até o próximo deploy e documentar que essa versão não tem dashboard → Operador fica sem visibilidade de estoque crítico até o conserto
- **Recomendação:** Fazer a correção: é rápido (uma linha na consulta) e bloqueia o uso do dashboard inteiro. Prioridade alta.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260605_wms_excecoes_dashboards.sql linha 38-51; 20260520_ledger_simplificado.sql linha 36

## P129 — Dois cliques muito rápido no botão de confirmar (pessoa aperta duas vezes em 100 milissegundos)
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Painel de Acompanhamento de Fluxo (produtividade e atrasos por etapa)
- **Imagina assim:** Operador em embalagem aperta o botão +1 duas vezes em sequência muito rápida
- **Hoje:** Operador aperta o botão. Primeira vez: quantidade sobe de 10 pra 11 (completa os 11 que o pedido pediu). Segunda vez: sobe pra 12. Item fica marcado errado, com mais quantidade do que deveria ter, e o pedido viaja com informação errada.
- **Por que importa:** O sistema erra a contagem de peças que saem. Se a embalagem diz que saíram 12 mas o pedido era 11, quando chegar na loja (no cutover final) a contagem fica torta. Gera desperdício, divergência com cliente e retrabalho.
- **Opções:** (A) Desabilitar o botão por meio segundo depois que clica (congelar tela por 500ms na tela) → O operador clica, button some por 500ms, não consegue clicar novamente. Simples, funciona na hora, mas operador vê a tela travar por um tempo.  ·  (B) O sistema por trás sabe quem está clicando e quando (manda um ID único pra cada tentativa). Se chegar dois cliques com mesmo ID em 60 segundos, ignora o segundo. → Funciona mesmo se houver problema de conexão (click duplicado chega de novo). Mais seguro, mas precisa codificar a memória de quem já pediu o quê.  ·  (C) Travar a linha da prateleira quando alguém está mexendo (só um operador edita por vez) → Impede duas ações no mesmo instante uma pisando na outra, mas operador A fica esperando se conexão cair. Pode ficar travado.
- **Recomendação:** Usar congelar tela no botão (+500ms desabilitado) é o mais rápido de fazer. Se quiserem garantia total (mesmo com problemas de rede), implementar ID único de request no sistema por trás.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/confirmar-item-embalagem/route.ts:83-95 / src/app/wms/separacao/embalagem/page.tsx

## P130 — Dois operadores marcam o mesmo item como embalado no mesmo instante
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Painel de Acompanhamento de Fluxo (produtividade e atrasos por etapa)
- **Imagina assim:** Pedido P-XYZ tem 5 peças pra embalar. Operador A aperta +5, operador B aperta +5, tudo no mesmo momento.
- **Hoje:** Operador A começa a salvar: lê quantidade = 0, calcula que vai ficar 5. Operador B lê a mesma quantidade = 0, calcula que vai ficar 5 também. A salva primeiro, B salva depois e sobrescreve. Item fica marcado com 5 (que é certo, por sorte). Mas e se A clicar +3 e B clicar +2? Ambos leem 0. Só fica registrado +2 (o de B). Os 3 de A somem.
- **Por que importa:** Operadores podem estar embalando a mesma coisa ao mesmo tempo. Se o sistema erra a soma, fica faltando quantidade marcada, e o pedido sai incompleto ou fica acusando quantidades erradas. Gera atraso, reembalagem, e confusão no estoque.
- **Opções:** (A) Travar a linha (uma trava pra ler e gravar sem pisar um no outro). Operador A tranca, lê 0, soma 3, salva e destrava. Só aí B consegue fazer a mesma coisa com o 2. → Tudo-ou-nada correto, mas precisa de quem tira a trava se A sair sem destravar (desfazer manual). Mais complexo no banco.  ·  (B) Usar uma função de gravar ou atualizar com soma: +3 somado ao que já existe, não sobrescrita. → Automático e tudo-ou-nada. Se A e B salvam simultaneamente, o banco sabe que tem que somar: fica 3+2=5.  ·  (C) A tela avisa ao operador: 'Alguém já está editando esse item, tente de novo'. Usa versão/hash pra checar. → Operador B vê que perdeu, tenta novamente. Mais user-friendly, mas gera retry e pode ser confuso.
- **Recomendação:** Usar gravar ou atualizar com soma no banco. É automático, rápido, sem risco de trava travada. Código muda em 2 linhas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/confirmar-item-embalagem/route.ts:84-95

## P131 — Um clique duplo no 'confirmar item' faz o sistema contar duas vezes
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Produtividade e ranking dos operadores
- **Imagina assim:** O separador clica duas vezes rapidinho no botão 'confirmar item' no celular. A quantidade sobe de 0 para 2 em vez de 0 para 1.
- **Hoje:** Primeira ação: quantidade vira 1. Segunda ação: quantidade vira 2. O sistema registra 2 incrementos. Se fica marcado como 'embalagem completa', dispara aviso de conclusão 2 vezes.
- **Por que importa:** O operador separou 1 item, não 2. Contagem errada no final do dia gera relatório falso de produtividade. Aviso dispara 2 vezes, causa confusão no sistema automático que vem depois.
- **Opções:** (A) Enviar um ID único com cada clique; se chegar repetido em menos de 1 segundo, sistema ignora o duplicado. → Simples. Requer mudança no aplicativo pra enviar ID único em cada ação.  ·  (B) Travar a prateleira enquanto processa: ninguém consegue clicar de novo até terminar. → Mais seguro. Requer mudança no banco de dados (linha 88-95 do arquivo de rota).
- **Recomendação:** Use o ID único. É mais rápido de implementar e funciona bem pra dois cliques seguidos.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/confirmar-item-embalagem/route.ts:88-95

## P132 — Desfazer embalagem não limpa a data de conclusão
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Produtividade e ranking dos operadores
- **Imagina assim:** Um item foi bipado inteiro (marca 'completo' com data/hora). Depois precisa devolver pra separar de novo. Sistema volta pra etapa 'separação', mas a data de conclusão da embalagem fica lá.
- **Hoje:** Não existe rota pra estornar. O pedido volta pra 'separado', mas a data fica gravada. O ranking de desempenho ainda conta esse operador 1 vez (não retraí o ponto).
- **Por que importa:** O operador de embalagem recebeu crédito por uma conclusão que foi desfeita. Relatório de produtividade fica errado. Se alguém analisa depois, vê data de conclusão em pedido que ainda tá em separação.
- **Opções:** (A) Criar rota de estorno: quando usuário clica 'desfazer embalagem', limpa data + operador automaticamente. → Direto. Tira o crédito do ranking também.  ·  (B) Usar um histórico de movimentações: cada ação deixa rastro; ranking lê apenas eventos finalizados que não foram revertidos. → Mais rastreável. Mais complexo de implementar.
- **Recomendação:** Crie a rota de estorno. Toda vez que pedido volta pra separação, execute: limpar data + limpar operador de embalagem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** Nenhuma rota de estorno de embalagem encontrada; migration 20260515 linhas 188-192

## P133 — Galpão preferencial desaparece quando deletado
- [ ] **vou fazer** · gravidade: grave · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Controle de Empresas, Filiais e Galpões
- **Imagina assim:** NetAir tem CWB como galpão preferencial. Alguém deleta CWB diretamente do banco de dados. O sistema automaticamente remove CWB da lista de preferenciais da NetAir, deixando ela sem galpão padrão.
- **Hoje:** NetAir tem CWB como preferencial. Um administrador (intencional ou acidental) deleta CWB. O banco de dados cascateia e remove automaticamente a vinculação entre NetAir e CWB. Depois disso, quando o sistema tenta rotear um pedido de NetAir, não encontra um galpão preferencial (fica vazio).
- **Por que importa:** Se a empresa fica sem galpão preferencial, o sistema não consegue decidir onde rotear os pedidos daquela empresa. Os pedidos ficam presos ou vão pra lugar errado.
- **Opções:** (A) Bloquear delete completamente se o galpão está vinculado a qualquer empresa → Seguro, mas rígido. Se o galpão virar obsoleto, precisa desvincular tudo manualmente primeiro.  ·  (B) Permitir delete, mas antes desvincula de todas as empresas (desfaz as relações) e avisa o admin → Mais flexível, mas arriscado: se o galpão tem estoque, fica órfão. Precisa de estoque inteligente depois.  ·  (C) Permitir apenas soft-delete (marca como inativo em vez de apagar de verdade) → Mantém histórico, seguro, mas o galpão continua visível em relatórios antigos.
- **Recomendação:** Bloquear delete se o galpão é preferencial de alguma empresa OU tem estoque/pedidos em andamento. Avisar exatamente qual empresa/pedido impede a exclusão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** galpoes/[id]/route.ts

## P134 — Criar operador sem nenhuma loja / galpão
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Gestão de funcionários e acesso aos galpões
- **Imagina assim:** O administrador clica em Criar novo operador mas não marca nenhuma loja. O botão continua ativo.
- **Hoje:** O sistema cria o operador com a lista de lojas vazia. Quando esse operador entra no sistema, não consegue ver pedidos nem produtos de lugar nenhum. Fica travado.
- **Por que importa:** Um operador sem loja é inútil. Ele loga mas não consegue fazer nada. É confusão: o dono acha que funcionário foi criado, mas funcionário não consegue trabalhar.
- **Opções:** (A) Deixar como está (criador fica quebrado) → Continua o problema  ·  (B) Sistema exigir ≥1 loja ao criar e salvar → Operador nasce com acesso à loja (funciona)
- **Recomendação:** Escolha a opção 2: exigir que marque pelo menos uma loja. Botão Criar só fica ativo quando houver loja marcada.
- **➡️ MINHA ESCOLHA:** 
- **Código:** aba-funcionarios.tsx:546-548, route.ts:196-203

## P135 — Deletar operador que já mexeu em pedidos e movimentações
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Gestão de funcionários e acesso aos galpões
- **Imagina assim:** Admin deleta o João, que já tinha lançado vários produtos no sistema e aprovado pedidos.
- **Hoje:** O sistema 'exclui' o João da lista de usuários, mas nos históricos de movimentações (quem lançou o produto X, quem aprovou o pedido Y) o nome fica vazio ou quebrado. Relatório e rastreabilidade ficam confusos.
- **Por que importa:** Auditoria. Se precisa verificar quem lançou um produto ou quem cometeu um erro, o sistema mostra vazio. Responsabilidade fica perdida. Também: se outro João for criado depois, confunde.
- **Opções:** (A) Deixar como está (histórico fica sem nome, só UUID) → Perda de rastreabilidade, relatórios confusos  ·  (B) Ao deletar, copiar o nome do João para os históricos antes de remover → Relatório mostra 'João (excluído)' — fica claro
- **Recomendação:** Escolha a opção 2: guardar o nome na tabela de histórico quando deleta um operador. Assim auditoria fica inteira.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:232-259, migrations/20260310_create_galpao_empresa_grupo.sql linha 66

## P136 — Único admin desativa a si mesmo sem aviso
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Gestão de funcionários e acesso aos galpões
- **Imagina assim:** O único admin do sistema está fazendo manutenção, clica em Desativar em seu próprio perfil e aprova.
- **Hoje:** Admin fica inativo. O sistema trava: ninguém consegue acessar a aba de Configurações ou criar usuários. Empresa paralisa.
- **Por que importa:** Lockout. Sem admin, ninguém consegue mexer em usuários, lojas ou configurações. Emergência operacional.
- **Opções:** (A) Permitir (como hoje) → Sistema trava, empresa fica paralizada  ·  (B) Sistema recusar desativação do último admin → Admin é protegido, sistema nunca fica orphan
- **Recomendação:** Escolha a opção 2: sistema deve avisar 'Você é o único admin, não posso desativar' e bloquear. Mesma proteção que tem em outros sistemas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:796-799, [id]/roles/route.ts:57-82

## P137 — Editar operador dias depois remove acesso sem querer
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Gestão de funcionários e acesso aos galpões
- **Imagina assim:** Admin abriu a edição do João ontem, com João marcado na loja de Curitiba. Sai sem salvar. Volta 2 dias depois, reabre a edição: a tela mostra nenhuma loja marcada (resetou). Admin não percebe e clica Salvar.
- **Hoje:** João perde acesso à loja. Próximo login, ele não consegue entrar em lugar nenhum — mesmo sem ninguém ter tirado dele propositalmente.
- **Por que importa:** Confusão operacional. Funcionário esperava estar em Curitiba, de repente não consegue entrar. Admin acha que foi culpa do último clique, quando na verdade foi um bug de form.
- **Opções:** (A) Deixar form resetar (como hoje) → Risco de perder acesso acidentalmente  ·  (B) Form carregar com as lojas atuais preenchidas + bloqueio se ficar vazio para operador → Admin vê o que era, não consegue deixar vazio por acidente
- **Recomendação:** Escolha a opção 2: combina com o fix de 'não deixar criar vazio'. Form sempre mostra o estado atual.
- **➡️ MINHA ESCOLHA:** 
- **Código:** aba-funcionarios.tsx:751-752, route.ts:200-202

## P138 — Ao mudar as permissões de um cargo, as permissões somem e depois voltam (operação quebrada)
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Quem faz o quê no sistema (e quando perde acesso)
- **Imagina assim:** Um admin tira todas as permissões de um cargo e adiciona novas, tudo de uma vez
- **Hoje:** O sistema tira as permissões antigas e tenta adicionar as novas. Se algo der errado na metade (falta de espaço em disco, por exemplo), o sistema devolve erro — o cargo fica sem NENHUMA permissão até o admin tentar de novo.
- **Por que importa:** Se o cargo fica sem permissões, os operadores que usam esse cargo não conseguem fazer nada até o admin refazer tudo. Isso é caótico em produção.
- **Opções:** (A) Usar o banco de dados pra 'reservar' as novas permissões antes de tirar as antigas — se tudo der certo, confirma; se não, desfaz tudo → Seguro, mas um pouco mais lento (frações de segundo)  ·  (B) Guardar as novas permissões num local temporário, depois trocar de uma vez — se falhar, volta pra antes → Mais rápido, mas mais complexo pra entender o código depois
- **Recomendação:** Use o banco de dados. É o jeito mais simples e confiável. Se algo falha na metade, o sistema volta como se nada tivesse acontecido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:66-75

## P139 — Dois admins mudando o mesmo cargo ao mesmo tempo — o segundo sobrescreve o primeiro
- [ ] **vou fazer** · gravidade: grave · tema: Permissões e quem pode fazer o que · fluxo: Quem faz o quê no sistema (e quando perde acesso)
- **Imagina assim:** Admin de Curitiba e admin de São Paulo tentam adicionar permissões diferentes pro cargo 'Separador' no mesmo segundo
- **Hoje:** Admin A tira as permissões antigas, Admin B faz a mesma coisa quase junto. Ambos tentam adicionar sua lista de permissões. A lista do Admin B 'vence' — a lista do Admin A desaparece.
- **Por que importa:** O admin não vê que suas mudanças foram perdidas. Dias depois, alguém reclama que o Separador não consegue fazer algo que deveria. É impossível entender o que aconteceu.
- **Opções:** (A) Colocar um 'cadeado' no banco de dados enquanto um admin edita. Segundo admin espera o primeiro terminar. → Seguro e claro. Segundo admin vê uma mensagem 'este cargo está sendo editado por fulano'.  ·  (B) Deixar como está (aceitar que o último a salvar vence) → Rápido, mas perigoso e confuso.
- **Recomendação:** Coloque o cadeado. É uma proteção básica que evita horas de investigação depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:66-75

## P140 — Três funcionários mexem no token ao mesmo tempo e o sistema fica confuso
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Autenticação com Tiny, Mercado Livre e Impressoras
- **Imagina assim:** Três tarefas automáticas tentam renovar o token Tiny em paralelo. Tarefa 1 renova e salva a chave nova. Tarefa 2 (quase simultânea) também renova com a chave antiga e salva outra. Tarefa 3 faz o mesmo. No final, o banco fica com a chave de quem salvou por último, e as anteriores ficam inúteis.
- **Hoje:** 3 tarefas em segundo plano processam pedidos Tiny em paralelo. Token expirou em 11:55:00, agora são 11:56:00. Tarefa 1 pede chave nova (chave_anterior=R1), recebe acesso_novo=A1 + nova chave R2, salva no banco. Tarefa 2 (quase no mesmo instante) pede chave com R1 (ainda não viu que Tarefa 1 atualizou), recebe A2 + R3, salva. Tarefa 3 idem, A3 + R4. Banco fica com A3/R4 (ou com A2/R3, dependendo de quem salvou por último). Se R2 e R3 ficarem gastos, a próxima renovação com R4 pode funcionar ou falhar, e o sistema trava.
- **Por que importa:** Se as chaves ficarem inconsistentes, o sistema não consegue mais renovar. Pedidos ficam parados, sem renovação de acesso. Vendas interrompem. Risco alto de indisponibilidade.
- **Opções:** (A) Implementar travamento: antes de renovar, a tarefa ativa um travamento no banco. Outras tarefas veem o travamento, aguardam ou usam token velho. Quem conseguiu o travamento renova, salva chave nova, libera o travamento. → Uma única renovação por vez. Todas as tarefas trabalham com a mesma chave válida. Sem confusão, sem duplicação.  ·  (B) Deixar como está (cada um renova quando quer) → Risco continua. Próximo pico de tráfego paralelo pode derrubar a integração com Tiny.
- **Recomendação:** Aplicar o travamento. É a mesma solução que já existe para MercadoLivre e funciona. Copie a lógica.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/tiny-oauth.ts:83-185

## P141 — Gerente deleta uma conta de impressora e ninguém sabe quais prateleiras ficarão sem etiqueta
- [ ] **vou fazer** · gravidade: grave · tema: Integração com a loja (Tiny / marketplace) · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Um gerente está na tela de configuração de impressoras (conta A, B, C). Clica no X para deletar a conta A. Uma caixa de confirmação avisa: 'Remover conta? Prateleiras e usuários que usam impressoras dessa conta ficarão sem impressora.' Clica confirma.
- **Hoje:** A conta A é deletada do sistema. Qualquer prateleira ou usuário que estava usando a impressora da conta A agora fica com nenhuma impressora (o sistema coloca como vazio). Quando operador tenta imprimir, não imprime nada — sem aviso claro do por quê.
- **Por que importa:** O gerente pode deletar uma conta esquecendo que 3 prateleiras diferentes (SP, RJ, MG) usavam aquela impressora. Etiquetas param de imprimir em 3 galpões sem ninguém perceber até começarem a reclamar.
- **Opções:** (A) Mostrar lista: 'Se deletar, estas 3 prateleiras ficarão sem impressora: SP (Zona 1), RJ (Zona 2), MG (Zona 1)' → Gerente vê o impacto real e decide com informação. Pode avisar os responsáveis ou configurar uma nova impressora antes de deletar.  ·  (B) Bloquear a deleção se a conta estiver em uso → Gerente precisa primeiro remover a conta de todas as prateleiras, depois deletar. Mais seguro, mas mais passos.  ·  (C) Deixar como está (mostrar aviso genérico) → Continua acontecendo: gerente deleta e surpresa — 3 prateleiras sem impressora.
- **Recomendação:** Escolha a primeira opção. Mostre a lista de prateleiras afetadas ANTES de deletar. Não impede a ação, mas deixa claro o risco.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/admin/printnode/contas/[id]/route.ts:91-116

## P142 — Reimpressora quebra quando serviço de impressão falha
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Reimpressão de etiqueta de separação
- **Imagina assim:** Operador tenta reimprimir uma etiqueta depois que o pedido foi embalado
- **Hoje:** Quando o sistema envia a etiqueta pro serviço de impressão e ele cai (sem internet, serviço fora, sem crédito), o operador recebe erro '500 - Erro Interno' na tela. A gente registra que tentou imprimir mas falhou. O operador consegue clicar reimprimir novamente porque o sistema deixa o botão ativo.
- **Por que importa:** Se a impressora fica indisponível no meio da reimpressão, o operador não consegue saber se a etiqueta foi enviada ou não. Fica a reimpressão pendurada no sistema até um gerente resolver manualmente.
- **Opções:** (A) Sistema tenta sozinho 3 vezes (com 10 segundos de espera cada), se continuar falhando avisa o operador → Operador vê mensagem clara só se não conseguir de verdade. Reduz cliques desnecessários.  ·  (B) Sempre mostrar ao operador qual tentativa é (ex: 'tentativa 2 de 3'), deixar que ele decida se clica novamente → Operador tem controle mas precisa acompanhar mais. Mais cliques.  ·  (C) Deixar como está agora: mostrar erro e deixar operador clicar novamente → Simples mas operador pode ficar confuso se acha que não enviou a primeira vez.
- **Recomendação:** Opção 1. O sistema tenta 3 vezes sozinho. Se falhar, marca com vermelho claro pro operador: 'Impressora indisponível agora. Tente novamente daqui a 1 minuto'. Isso reduz 80% dos casos onde o operador acaba enviando 5 vezes a mesma etiqueta sem perceber.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:110-122

## P143 — Etiqueta desaparece do sistema depois de 7 dias
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Reimpressão de etiqueta de separação
- **Imagina assim:** Um pedido foi impresso e enviado há 8 dias. Agora descobrimos que a impressora que imprimiu perdeu a etiqueta física (aquela folha A4 de papel). Operador quer reimprimir.
- **Hoje:** Tem um robô que roda toda noite. Depois de 7 dias que uma etiqueta foi impressa com sucesso, ele apaga o conteúdo da etiqueta do banco de dados (para economizar espaço). Quando o operador quer reimprimir, o sistema não acha a etiqueta guardada e tenta criar uma nova. Mas o sistema procura por pedidos que estão marcados como 'pendente' ou 'falhou'. Este pedido está marcado como 'impresso' (porque já foi impresso). O sistema não consegue criar uma nova etiqueta porque acha que já tentou tudo. Operador vê 'Falha ao reimprimir' e não consegue fazer nada.
- **Por que importa:** Depois de uma semana, se algo der errado com a impressão física, a gente não consegue reimprimir. O estoque está lá, mas não conseguimos mandar o pedido sem a etiqueta.
- **Opções:** (A) Guardar a etiqueta para sempre (sem apagar nuca) → Sistema fica maior, custeia mais espaço. Mas reimprimir sempre funciona. Sem surpresas depois de 7 dias.  ·  (B) Apagar depois de 7 dias como hoje, mas deixar o sistema recriar a etiqueta quando pedir reimprimir → Economiza espaço. Reimprimir é um pouco mais lento porque precisa chamar o fornecedor de novo. Se o fornecedor mudou alguma coisa, a nova etiqueta pode ser diferente.  ·  (C) Guardar por 30 dias em vez de 7 → Meio termo. Mais tempo pra reimprimir antes de perder. Economia menor.
- **Recomendação:** Opção 2. Apagar depois de 7 dias conforme hoje, mas deixar recriar. Só funciona se o sistema consegue recriar a etiqueta corretamente. Recomendo: quando operador clicar reimprimir e a etiqueta tiver sido apagada, o sistema avisa 'Esta etiqueta foi apagada depois de 7 dias. Vou pedir uma nova ao fornecedor, pode levar 5 segundos.' Aí tenta recriar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:65-76

## P144 — Reimprimir coloca só nota fiscal, perde a etiqueta de envio
- [ ] **vou fazer** · gravidade: grave · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Reimpressão de etiqueta de separação
- **Imagina assim:** Operador clica reimprimir. O fornecedor manda 2 etiquetas: uma é a nota fiscal (legal) e outra é a etiqueta de envio (que vai pro pacote pro cliente). Sistema imprime só a nota fiscal, perde a segunda etiqueta.
- **Hoje:** Quando buscamos as etiquetas do fornecedor, ele às vezes manda um ZIP com 2 arquivos: 'Nota Fiscal.txt' e 'Etiqueta de Envio.txt'. O sistema pega os dois, junta em um arquivo só e cachea. Depois, quando operador reimprimi, o sistema precisa separar. Tem uma linha de código que diz 'se tem múltiplas etiquetas, pega só a primeira'. Aí fica só a nota fiscal. A etiqueta de envio (aquela que precisa ir no pacote do cliente) desaparece.
- **Por que importa:** O cliente recebe o pacote sem a etiqueta de envio. Não consegue rastrear o código de envio. Suporte tem que resolver manualmente depois.
- **Opções:** (A) Sempre imprimir as duas (nota fiscal + etiqueta de envio) → Cliente recebe etiqueta de envio corretamente. Precisa de impressora que aguenta 2 páginas. Mais gasto de papel.  ·  (B) Imprimir só a etiqueta de envio (esquecer a nota fiscal) → Menos papel. Mas a nota fiscal pode ser importante pra auditoria depois.  ·  (C) Deixar operador escolher qual imprime quando clicar reimprimir → Máxima flexibilidade. Operador precisa entender qual é qual. Mais cliques.
- **Recomendação:** Opção 1. Imprimir sempre as duas. Sistema deveria detectar quando vêm 2 etiquetas e avisar: 'Achei 2 etiquetas: Nota Fiscal e Etiqueta de Envio. Vou imprimir as duas.' Se operador só quer uma, aí sim deixa escolher, mas por padrão vai as duas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:92-93

## P145 — Tarefa fica travada quando o sistema falha no meio da execução
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Processamento automático de pedidos aprovados
- **Imagina assim:** Uma tarefa automática começa a rodar (marcada como 'em progresso'), mas falha no meio (ex: erro ao falar com a loja). O sistema nunca tenta fazer a tarefa de novo.
- **Hoje:** A tarefa fica travada em etapa 'em progresso' para sempre. Ninguém mais toca nela. Só um administrador consegue destravar manualmente.
- **Por que importa:** Pedidos não saem da fila. Estoque não é lançado. Cliente não recebe seu produto.
- **Opções:** (A) Timeout automático de 5 minutos → Tarefa volta pra fila sozinha, próxima tarefa que roda em segundo plano tenta de novo. Pedido sai mais rápido.  ·  (B) Deixar como está (manual) → Admin tem que mecher. Pedidos atrasam enquanto ninguém destravar.
- **Recomendação:** Implementar timeout. Reduz atrasos e pedidos travados.
- **➡️ MINHA ESCOLHA:** 
- **Código:** execution-worker.ts:140-154

## P146 — Operador clica 'Lançar' duas vezes (rede demora), estoque sobe em dobro
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Lançamento de Estoque em Emergência (retroativo)
- **Imagina assim:** Exemplo concreto: você tem 0 un. de uma peça. Operador lança 100 un. retroativas. A rede demora. Ele clica 'Lançar' de novo por desespero.
- **Hoje:** O sistema NÃO impede o segundo clique. Criam-se DOIS lançamentos de 100 cada. Saldo sobe pra 200 em vez de 100. Se o custo foi informado, custo médio da peça recalcula errado também.
- **Por que importa:** Seu estoque fica inflado. Relatórios errados. Você pode vender mercadoria que não existe. Pra corrigir depois precisa fazer ajuste manual (demora, causa retrabalho).
- **Opções:** (A) Desabilitar o botão automaticamente enquanto a ação está em progresso → Usuário não consegue clicar 2x. Solução simples, visual.  ·  (B) Sistema recusa o segundo pedido se chegar dentro de alguns segundos → Funciona mesmo se o botão não for desabilitado. Protege quando a rede oscila.  ·  (C) Sistema gera um código único pra cada lançamento e recusa repetição desse código → Funciona mesmo se operador espera horas. Mais seguro, mas mais complexo.
- **Recomendação:** Comece com a opção 1 (desabilitar botão) porque é rápida. Se quiser segurança máxima, mude pra opção 3 depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/retroativos/page.tsx linha 160-176

## P147 — Estoque de lançamento retroativo já foi parcialmente vendido; estorno falha
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Lançamento de Estoque em Emergência (retroativo)
- **Imagina assim:** Você recebe um lançamento retroativo de 100 un. O sistema cria a entrada. Depois, 30 un. saem pra um pedido (foram separadas e despachadas). Agora o operador quer 'reconciliar' (fazer o sistema aceitar que esses 100 realmente chegaram).
- **Hoje:** O sistema tenta devolver os 100 inteiros pro fornecedor (lógica: se chegou, precisa estornar). Mas saldo atual é 70. Sistema diz 'erro: saldo insuficiente'. Reconciliação trava. O lançamento fica perdido (nem estornado, nem reconciliado). Operador fica confuso.
- **Por que importa:** Lançamentos retroativos são pra casos excepcionais (ajustes, dívidas). Se ficarem 'travados', você perde rastreabilidade. Auditoria fica a perder.
- **Opções:** (A) Sistema avisa e pergunta ao operador: 'Você tem 70 un. livres agora. Deseja estornar só esses 70?' → Operador faz a escolha. Reconciliação completa parcialmente. Dados ficam corretos.  ·  (B) Sistema estorna automaticamente só o que tem de saldo, sem avisar → Rápido. Mas operador pode não notar que estornou menos do que lançou (confusão depois).  ·  (C) Sistema bloqueia saída de pedidos enquanto houver lançamento retroativo não-reconciliado → Força reconciliação rápida. Mas operador fica impedido de vender até resolver o ajuste (pode ser irritante).
- **Recomendação:** Use a opção 1: avisar e deixar operador escolher. Assim vocês mantêm controle e auditoria fica limpa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:599-633

## P148 — Operador clica 'Reconciliar' duas vezes (duplo clique), estorno dobra
- [ ] **vou fazer** · gravidade: grave · tema: Inventário e acertos de saldo · fluxo: Lançamento de Estoque em Emergência (retroativo)
- **Imagina assim:** Lançamento retroativo está criado com 100 un. Operador clica 'Reconciliar' pra 'fechar' o ajuste. A rede demora. Ele clica de novo.
- **Hoje:** O sistema NÃO verifica se já reconciliou. Tenta criar DOIS estornos de 100. O primeiro estorno reduz o saldo em 100. O segundo estorno tenta sair 100 novamente. Se o saldo ficou negativo, falha. Se conseguir, estoque fica errado (estornado em dobro).
- **Por que importa:** Parecido com o problema 1, mas ainda pior: você estorna acidentalmente o mesmo ajuste 2x. Seu saldo fica artificialmente baixo. Você acha que faltam produtos quando na verdade estão lá.
- **Opções:** (A) Sistema marca o lançamento com 'data de reconciliação' após primeiro clique. Bloqueia segundo clique se já está reconciliado. → Seguro. Duplo clique vira 'sem efeito'. Operador pode clicar quantas vezes quiser, sem dano.  ·  (B) Sistema verifica se já existe um estorno ligado a esse lançamento. Se existir, recusa criar outro. → Mesma proteção. Implementação mais simples.
- **Recomendação:** Use opção 2: é mais rápida de implementar. Verifica 'já tem estorno ligado? não faz de novo'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:599-633

## P149 — Varredura pós-entrada falha silenciosamente; pedidos não recebem aviso de saldo aparecido
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Lançamento de Estoque em Emergência (retroativo)
- **Imagina assim:** Você recebe entrada de 500 un. de um produto. Sistema cria a entrada normalmente. Depois dispara uma tarefa automática: 'procure por pedidos que estavam esperando esse saldo e avise-os que pode separar agora'.
- **Hoje:** Se essa tarefa automática falhar (erro no banco de dados, timeout, coisa rara), o erro é registrado mas ninguém trata. A tarefa não é reexecutada. Pedidos em 'esperando saldo' não recebem o aviso. Operador não vê o banner de 'saldo apareceu'. Pedidos ficam invisíveis até alguém notar manualmente.
- **Por que importa:** Pedidos atrasam. Clientes reclamam. Você perde eficiência porque ninguém avisa a equipe de que pode separar.
- **Opções:** (A) Colocar tarefa numa fila com tentativas automáticas (tenta 3x se falhar, espera e tenta de novo) → Se falha por oscilação de rede, se recupera sozinha. Confiável.  ·  (B) Criar uma verificação automática em horário baixo que refaz varredura de todos os pedidos bloqueados → Mais lento, mas pega atrasos ocasionais. Pode ser executado à noite.  ·  (C) Manter log detalhado e alertar admin se varredura falhar → Você fica ciente e pode investigar. Mas requer monitoramento ativo.
- **Recomendação:** Opção 1 é o padrão da indústria: coloque em fila com retry. Se time tiver capacidade, adicione opção 2 pra segunda camada de proteção.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:234-263

## P150 — O mesmo clique no botão é processado 2 vezes
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Um operador clica o botão 'Acertar Estoque' para reconciliar a compra que chegou. A internet está lenta, ele não vê resposta, acha que o botão não funcionou e clica de novo.
- **Hoje:** A primeira ação é executada: o sistema mete 10 peças que ele declarou. Depois, quando o segundo clique chega, o sistema tenta fazer a mesma ação de novo. Ele avalia o saldo (que JÁ foi acrescido de 10), tenta tirar 10 novamente e dá erro porque saldo não dá conta — nega a segunda ação.
- **Por que importa:** O operador fica frustrado, acha que estoque não subiu e tenta de novo ou vai reclamar. O registro fica confuso: foi pra 10 ou não foi?
- **Opções:** (A) Antes de executar, o sistema verifica se essa ação já foi feita. Se sim, avisa 'sucesso' direto. → Operador clica 2 vezes, sistema responde '✓ Feito' na segunda vez. Estoque fica certo.  ·  (B) Só aceita clique a cada 3 segundos (bloqueia novo clique enquanto processa). → Operador não consegue clicar de novo. Mais seguro, mas UI fica travada por 3 seg.
- **Recomendação:** Opção 1 — permite que operador clique sem medo e sempre dá resposta clara.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:599-633

## P151 — Operador tenta acertar estoque de novo depois de semanas
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Dia 1: operador lança nota de 10 peças e clica 'Acertar'. Sistema executa. Dia 15: operador volta na tela, pensa 'deixa eu confirmar de novo' e clica novamente.
- **Hoje:** Sistema carrega os mesmos dados e tenta executar a ação de novo. Agora o saldo já tinha essas 10 peças desde o dia 1, então ao tentar tirar 10 novamente, não tem saldo. Dá erro e assusta.
- **Por que importa:** Operador já sabia que tinha feito isso dias atrás, mas o sistema não dá um 'ok, já está pronto' claro. Fica confuso se funcionou de verdade na primeira vez.
- **Opções:** (A) Sistema marca a nota como 'acertada' e nunca mais aceita aceitar de novo. → Operador clica no dia 1 e depois no dia 15, recebe 'já processada' no dia 15.  ·  (B) Sistema registra cada tentativa e avisa: 'você já acionou isso em 1º de junho, quer fazer de novo?' → Operador sabe que já tinha feito e pode escolher se quer fazer 2x.
- **Recomendação:** Opção 1 — não permite duplicação de jeito nenhum, mais seguro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:599-633

## P152 — 2 operadores acertam o estoque da mesma compra ao mesmo tempo
- [ ] **vou fazer** · gravidade: grave · tema: Tarefas automáticas e fila do sistema · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Dois gerentes estão na tela de compras pendentes. Ambos veem a compra #2024 com 10 peças. Ambos clicam 'Acertar' no mesmo instante.
- **Hoje:** Requisição 1 chega: adiciona 10 peças ao saldo. Requisição 2 chega quase junto: tenta adicionar 10 de novo. Sistema não validou 'já foi acertada?', então tira 10 duas vezes (ou tenta), criando confusão no saldo.
- **Por que importa:** Estoque fica errado: pode ficar +20 quando deveria ser +10, ou um dos gerentes recebe erro injusto porque o sistema não soube coordenar.
- **Opções:** (A) Usa um 'cadeado de banco de dados': a primeira requisição marca 'acertando', a segunda espera ou é rejeitada. → Gerente 1 consegue, Gerente 2 recebe erro ou aviso 'já está sendo processada'.  ·  (B) Sistema detecta e desfaz a duplicação automaticamente (se virou +20, volta pra +10). → Ambas as requisições parecem sucessos, mas sistema corrige nos bastidores.
- **Recomendação:** Opção 1 — evita duplicação desde o início, mais confiável.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:599-633

## P153 — Clique duplo no botão 'Separar' causa confusão
- [ ] **vou fazer** · gravidade: média · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Painel de Separação de Pedidos
- **Imagina assim:** Operador clica rápido 2 vezes no botão 'Separar 10 pedidos' → o sistema processa os mesmos 10 pedidos duas vezes
- **Hoje:** O sistema não valida se os pedidos já estão sendo separados. Na primeira clicada, marca os 10 como 'em separação'. Na segunda clicada, tenta marcar de novo, mas como já estão em separação, silenciosamente falha — o operador não sabe se funcionou ou não.
- **Por que importa:** Operador fica confuso: clicou, nada parece acontecer, então clica de novo. Gera dúvida sobre qual clique "pegou". Aumenta retrabalho e erros manuais.
- **Opções:** (A) Bloquear o botão por 2 segundos após clique (impedir múltiplos cliques) → Operador vê o botão desabilitado temporariamente — fica óbvio que a ação foi registrada.  ·  (B) Mostrar mensagem clara se tentar clicar 2x (tipo 'esses 10 pedidos já estão em separação') → Mesmo se clicar 2x, recebe feedback visual — remove a incerteza.
- **Recomendação:** Opção 1 é mais simples: bloqueie o botão por 2 segundos após clique. Isso evita qualquer confusão e funciona bem em um galpão com rotina intensa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/iniciar/route.ts:120-150

## P154 — Pedido antigo fica 'em separação' por dias
- [ ] **vou fazer** · gravidade: média · tema: Etapas do pedido (separação, embalagem, envio) · fluxo: Painel de Separação de Pedidos
- **Imagina assim:** Um pedido chegou pra separação, o operador não terminou a onda (deixou em andamento). Passa 2 dias. Outro operador abre o painel, vê esse pedido antigo ainda 'em separação', começa a separar itens dele usando estoque que pode ter sido movido ou realocado.
- **Hoje:** O sistema permite separar pedidos que estão há dias em 'em separação'. Se o estoque foi refeito ou reorganizado nesse meio-tempo, o novo operador pode puxar de uma prateleira diferente da planejada, causando desorganização.
- **Por que importa:** Estoque fica desorganizado. Alem disso, depois é impossível saber de verdade onde cada item foi puxado. Cria 'buracos' nas prateleiras e discrepâncias.
- **Opções:** (A) Cancelar automaticamente pedidos em 'em separação' há mais de 24h → Força o operador a replanejar. Evita que pedidos 'zumbis' fiquem ocupando lugar.  ·  (B) Avisar o supervisor a cada 12h que um pedido está parado há muito tempo → Supervisor toma decisão manualmente. Mais controle, mas requer vigilância.  ·  (C) Deixar como está (responsabilidade do operador/supervisor) → Menos automação, mas exige disciplina do time. Risco alto de confusão.
- **Recomendação:** Opção 1: cancele automaticamente após 24h com notificação. Isso força o replanejamento e evita pedidos 'fantasma' no estoque.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:70-76, 110-136

## P155 — Mercadoria com fornecedor equivalente: fica confuso qual produto está sendo guardado
- [ ] **vou fazer** · gravidade: média · tema: Compras de fornecedor · fluxo: Gestão de compras de fornecedor
- **Imagina assim:** Seu estoque usa o produto A. Infelizmente, o fornecedor de A não tem mais em stock. O gerente propõe guardar o produto B no lugar (é equivalente, faz a mesma função). O gerente clica 'Confirmar equivalente'. Aí ninguém sabe mais: o sistema guardou A ou B? Ou criou um novo produto? Se a próxima compra vier, qual código é registrado no histórico?
- **Hoje:** O código que confirma o equivalente está meio nebuloso. Provavelmente o sistema muda o código do produto (de A pra B) no pedido existente, ou deixa os dois nomes ali (um como original, outro como 'equivalente'). Mas ninguém confirmou isso. Se ficar ambíguo, o recebimento vai gravar um código, o histórico outro, e a contagem fica confusa.
- **Por que importa:** Se um cliente pedir 'me manda do produto A', e você enviou B sem documentar bem, pode virar briga depois. E no estoque, não dá pra encontrar nem A nem B.
- **Opções:** (A) Trocar de verdade: cancela o produto original (A), cria um pedido novo pro produto B. Fica claro dois pedidos separados. → Histórico limpo, sem ambiguidade. Operador sabe exatamente qual é qual.  ·  (B) Manter os dois no mesmo pedido: A fica como 'original', B fica como 'equivalente confirmado'. Nota que B foi aceito no lugar de A. → Menos cliques, mas o histórico fica com dois produtos. Confundidor se alguém ler rápido.  ·  (C) Deixa ambíguo (como pode estar agora): sistema muda A pra B internamente, mas mantém bilhete que era A. Próximo recebimento grava B. → Confusão garantida. Não recomendado.
- **Recomendação:** Escolha opção 1: cancela A, cria novo pedido B. Mais clicks, mas ninguém fica confuso depois. Documente essa regra clara no manual do gerente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Gestão de compras de fornecedor")

## P156 — Fornecedor muda de localidade e ninguém avisa
- [ ] **vou fazer** · gravidade: média · tema: Compras de fornecedor · fluxo: Trocar um produto em uma compra (antes de fazer a encomenda)
- **Imagina assim:** Você trocou um SKU de um fornecedor de Curitiba para outro fornecedor que fica em São Paulo. Os dados do galpão sugerido para a compra deveriam mudar, mas não avisa nada.
- **Hoje:** O sistema muda o fornecedor nos dados internos em silêncio. A próxima vez que você abre, o item já aparece no card do novo fornecedor. Se havia uma compra aberta com o fornecedor antigo, ela fica órfã (sem itens). Você pode nem perceber que o galpão de destino mudou.
- **Por que importa:** Cada fornecedor fica em um galpão. Se você não percebe que a localidade mudou, pode mandar a nota para o galpão errado ou perder tempo procurando mercadoria que chegou em outro lugar.
- **Opções:** (A) Bloquear a troca se há compra aberta para o fornecedor antigo → Sistema recusa: 'tem compra aberta para Multiqualita, cancela ou deixa chegar antes de trocar de fornecedor'. Você é forçado a resolver a compra antiga primeiro.  ·  (B) Avisar mas deixar trocar, marcando compra antiga como descontinuada → Permite a troca e avisa: 'compra anterior será descontinuada'. Compra antiga fica fechada sozinha. Você decide se acha tudo bem.
- **Recomendação:** Avisar e bloquear se há compra aberta. Operador resolve a compra anterior (recebe ou cancela) e aí troca. Leva dois minutos mas evita nota fiscal chegando no lugar errado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:situacao descrita

## P157 — Devolução chega sem informação de quem é a loja — fica como 'vazio'
- [ ] **vou fazer** · gravidade: média · tema: Integração com a loja (Tiny / marketplace) · fluxo: Devolução com Troca de Peça
- **Imagina assim:** Uma devolução chega (talvez de um aviso automatizado que deu ruim, ou nota manual). Ninguém preencheu de qual loja/empresa veio. Operador classifica mesmo assim.
- **Hoje:** O sistema tenta adivinhar procurando a nota de venda original. Não acha (talvez foi nota manual, talvez o aviso bugou). Campo de loja fica branco. Quando depois faz relatório de devoluções por loja, essa aparece como '(vazio)' — ninguém sabe de quem era.
- **Por que importa:** Relatórios ficam incompletos. Não dá pra rastrear se a devolução veio de qual loja/revenda. Pra fins de cobrança ou bônus, fica confuso.
- **Opções:** (A) Tornar obrigatório preenchimento de loja no formulário quando o sistema não achar a nota original → Operador preenche na hora. Dados sempre completos. Relatórios mostram direitinho.  ·  (B) Deixar em branco e depois tentar corrigir manualmente no relatório (ex: exportar, preencher em planilha, reimportar) → Trabalhoso e propenso a erro. Relatórios temporariamente incorretos.
- **Recomendação:** Tornar obrigatório (opção 1). Pequeno incômodo do operador agora, grande ganho de integridade depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:142-165

## P158 — Devolução com troca de produto aparece no relatório de compras (mistura tudo)
- [ ] **vou fazer** · gravidade: média · tema: Relatórios e indicadores · fluxo: Devolução com Troca de Peça
- **Imagina assim:** Alguém devolveu um item, e ele entrou no sistema como 'devolução com troca de SKU' (novo produto). Quando faz relatório que lista 'quem comprou do fornecedor e quanto', essa entrada de devolução aparece misturada.
- **Hoje:** Relatório de 'Movimentos por Loja' lista tipo de movimento. Vira matéria-prima: 'Produto XYZ | Loja ABC | Tipo: Entrada | 5 un | R$ 52,50 | Custo 10,50'. Mas quem vê o relatório não sabe se foi compra de verdade ou se foi devolução reprocessada. Campo de loja/empresa muitas vezes fica vazio pra esse tipo de entrada.
- **Por que importa:** Relatórios que agregam pra decisão (quanto custa um produto, quem fornece) ficam viciados. Cálculo de custo médio sai errado.
- **Opções:** (A) Adicionar coluna 'Origem' no relatório mostrando se foi compra ou devolução → Fica transparente. Analista consegue filtrar se quer. Custo fica correto pra análise.  ·  (B) Excluir devoluções do relatório de compras de fornecedor (mostrar só compras de verdade) → Relatório fica limpo, mas se alguém quiser investigar origem de um item, precisa outro relatório.
- **Recomendação:** Adicionar coluna 'Origem' (opção 1). Assim cada um usa o dado como precisa, e fica rastreável.
- **➡️ MINHA ESCOLHA:** 
- **Código:** relatorios/movs-por-empresa/route.ts:54-61

## P159 — Estorno de contagem não desfaz só o que errou
- [ ] **vou fazer** · gravidade: média · tema: Cancelar e desfazer · fluxo: Verificação de Estoque na Hora da Separação
- **Imagina assim:** Um operador contou 8 unidades numa prateleira e o sistema aplicou. Depois descobrem que foi engano — deveriam ter contado 5. Precisam desfazer.
- **Hoje:** O sistema tem um botão de estorno, mas ele cancela TUDO da sessão de contagem — não só aquela prateleira errada. Se o operador tiver contado 3 prateleiras certas e 1 errada, o estorno joga fora as 4 contagens e as 4 mudanças de saldo. Depois precisa recontar as 3 certas.
- **Por que importa:** Seu operador perdeu tempo contando e agora perde mais tempo re-contando. A operação fica mais lenta e frustrante.
- **Opções:** (A) Continuar com estorno em lote (tudo junto) → Simples de codificar. Operadores refazem trabalho.  ·  (B) Permitir estorno de contagem individual → Operador desfaz só o errado. Mais ágil, mas código mais granular.
- **Recomendação:** Faça estorno individual. Vale a pena — suas contagens vão mais rápido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:1161-1226

## P160 — Dois supervisores aprovam a contagem ao mesmo tempo
- [ ] **vou fazer** · gravidade: média · tema: Inventário e acertos de saldo · fluxo: Contagem de estoque nas prateleiras
- **Imagina assim:** S1 e S2 veem a contagem pronta (sem problemas pendentes). Ambos clicam 'Aprovar' quase no mesmo segundo.
- **Hoje:** A primeira comunicação aprova. A segunda também aprova a mesma contagem de novo — o sistema não impede (não verifica se já foi aprovada antes de aprovar).
- **Por que importa:** A contagem pode ser processada duas vezes, gerando relatórios duplicados ou acertos de saldo incorretos. Parece um detalhe, mas depois fica difícil rastrear qual foi a contagem real.
- **Opções:** (A) Adicionar verificação no banco: só aprova se a etapa for 'em_revisao' (não 'já_aprovada') → Bloqueia a 2ª aprovação. Mais seguro, mas precisa de alteração no código.  ·  (B) Deixar como está (redundância inofensiva) → Sistema permite dupla aprovação, mas a tela mostra mensagem bonitinha de 'já estava aprovado'. Funciona, mas não é robusto.
- **Recomendação:** Fazer a verificação. Leva uma linha de código. Vale a pena pra evitar surpresas com duas aprovações.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/inventario.ts linhas 930-967

## P161 — Supervisor muda de ideia e o sistema não deixa corrigir
- [ ] **vou fazer** · gravidade: média · tema: Inventário e acertos de saldo · fluxo: Contagem de Estoque e Ajustes
- **Imagina assim:** Você faz uma contagem no dia, identifica uma diferença (por exemplo, faltam 5 peças de um produto que deveria ter 100). O sistema marca como 'Rejeitado' enquanto você decide. Você muda de ideia e quer aprovar mesmo assim. O botão desaparece da tela e nada funciona.
- **Hoje:** Depois que você rejeita ou aprova uma diferença, o sistema bloqueia todos os botões. Se voltar na página, o sistema pode mostrar a tela antiga (como era antes) e você clica 'Aprovar' de novo, mas o sistema não faz nada — só mostra uma mensagem que 'algumas mudanças não foram salvas'.
- **Por que importa:** Se você descobrir que estava errado depois de rejeitar, quer desfazer sem chamar o gerente. Hoje isso não é possível na interface normal.
- **Opções:** (A) Permitir que o supervisor aprove/rejeite de novo (refaz a decisão) → Você clica 'Reabrir', refaz a escolha, tudo fica consistente. Sem precisar chamar admin.  ·  (B) Manter como está: só admin consegue desfazer por fora do sistema → Precisa de alguém técnico mexer no banco de dados quando alguém muda de ideia.
- **Recomendação:** Use a primeira opção. Deixe o supervisor refazer a escolha clicando 'Reabrir'. Mais rápido e menos dependência de admin.
- **➡️ MINHA ESCOLHA:** 
- **Código:** divergencias/page.tsx:68-76, divergencias/route.ts:86

## P162 — Operador digita 12.5 unidades em vez de número inteiro — o sistema aceita e depois quebra
- [ ] **vou fazer** · gravidade: média · tema: Recebimento e guarda de mercadoria · fluxo: Transferência de estoque entre galpões
- **Imagina assim:** Operador está criando uma transferência de 12.5 unidades de um produto. Digita 12.5 no campo de quantidade.
- **Hoje:** Campo aceita o número quebrado. Sistema cria a movimentação com 12.5 unidades. Saldo do estoque vira 12.5. Quando depois for preciso faturar ou separar pro pedido, esses outros sistemas esperam número inteiro e quebram ou geram erro estranho.
- **Por que importa:** Você vende em unidades inteiras, mas estoque fica com número quebrado. Depois quando vai faturar ou separar, conta não fecha. Ou pior: alguém ve 12.5 e arredonda errado (12 ou 13) — estoque não bate mais.
- **Opções:** (A) Só inteiros — sistema rejeita se digitar 12.5 → Mais seguro pro seu negócio. Operador recebe erro claro: 'Digite um número inteiro'. Simples.  ·  (B) Permite decimais (como hoje) — pra produto a granel → Funciona pra produtos especiais. Mas nota fiscal e picking precisam lidar com isso. Mais complexo.
- **Recomendação:** Opção 1: rejeite números quebrados. Se você vende algum produto a granel (quilo, metro), configure esse produto específico pra aceitar decimais — o resto é inteiro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/components/wms/ui/modals.tsx:1176-1180

## P163 — Clique duplo no botão remover veiculo pode enganar o operador
- [ ] **vou fazer** · gravidade: média · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Compatibilidade de Veículos por Produto
- **Imagina assim:** Um operador está removendo um veiculo compatível com o produto. Ao mesmo tempo, outro operador (ou ele mesmo em outra aba) remove o mesmo veiculo.
- **Hoje:** Quando o segundo clique tenta remover um veiculo que ja nao existe, o sistema diz 'Veiculo removido com sucesso' na tela, mas na verdade nao havia nada pra remover. O operador fica confuso achando que fez alguma coisa.
- **Por que importa:** Operador não sabe se funcionou ou não. Gera dúvida sobre o que foi removido. Em um dia com muitas operações, vira confusão sobre qual veiculo ainda tá cadastrado.
- **Opções:** (A) Mostrar erro 'Esse veiculo ja foi removido' quando alguem tentar remover de novo → Operador fica avisado. Tira dúvida. Sem confusão.  ·  (B) Atualizar automaticamente a tela quando outro operador remove um veiculo (sockets em tempo real) → Evita o clique fantasma desde o inicio. Mais complexo de implementar, mas melhor experiência.
- **Recomendação:** Faça a primeira opção (erro claro). Rápido, direto, resolve o problema hoje.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/cross/produtos/[sku]/veiculos/[id]/route.ts:48-51

## P164 — Operador digita zero (0) e sistema aceita
- [ ] **vou fazer** · gravidade: média · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Pílula mostra 5 caixas. Operador limpa o campo acidentalmente (ou de brincadeira) e digita '0', bate Enter.
- **Hoje:** Sistema valida 'maior que zero?' em alguns casos, mas não todos. Pode passar '0' pro Tiny, que seta o saldo pra zero. Produto some do estoque sem motivo.
- **Por que importa:** Um clique errado (ou dedada) apaga o estoque. Não fica registro de por que virou zero, difícil de reverter depois.
- **Opções:** (A) Aceitar zero (como agora) → Usuário erra uma vez, estoque some, operador late descobrindo.  ·  (B) Rejeitar zero, pedir quantidade positiva → Impede dedadas. Se quer zerar, vai pra ajuste que deixa registro.
- **Recomendação:** Opção 2: rejeitar zero com mensagem clara 'quantidade deve ser maior que zero'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:42-47

## P165 — Produto não aparece nos pedidos parados quando estoque volta a ter quantidade
- [ ] **vou fazer** · gravidade: média · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Estoque de um produto virou zero (todas as caixas saíram). Ficou parado por 3 dias. Hoje encontraram 5 caixas no fundo do galpão, operador corrige de 0 para 5. Mas há um pedido parado esperando esse produto (estava em fila de compra, porque faltava). Esse pedido continua parado?
- **Hoje:** Sim. Sistema corrige o saldo no Tiny e na tela. Mas não avisa o sistema de reconhecimento de pedidos parados que 'ei, esse produto agora tem estoque'. O pedido parado continua esperando, até que um operador refaça a busca manualmente (30 segundos depois ou quando atualizar a página).
- **Por que importa:** Perda de tempo: produto tá lá, pedido espera desnecessariamente. Operador não vê que problema se resolveu sozinho.
- **Opções:** (A) Não fazer nada (como hoje) → Pedidos parados continuam até refresh manual. Perda de tempo.  ·  (B) Enfileirar tarefa que roda sozinha em segundo plano e varre pedidos parados → Em segundo plano, sistema vê que produto agora tá lá e libera pedido. Sem delay manual.
- **Recomendação:** Opção 2: enfileirar varredura. Custa pouco, economia de tempo operacional.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:139-151

## P166 — Dois operadores mexem no mesmo produto em galpões diferentes ao mesmo tempo
- [ ] **vou fazer** · gravidade: média · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Operador A está em Curitiba ajustando caixa de parafusos (corrige 100 pra 95). Operador B está em São Paulo, mesmo produto (corrige 50 pra 48). Clicam Enter no mesmo instante.
- **Hoje:** Ambas requisições chegam ao sistema quase junto. Tiny processa. Sem o registro das movimentacoes de estoque, não há trilha: quem mexeu? Quando? Qual ordem? Se depois houver discrepância, impossível auditar.
- **Por que importa:** Sem registro de quem fez o quê e em que ordem, auditoria fica impossível. Especialmente em movimentos simultâneos entre galpões.
- **Opções:** (A) Deixar como tá (sem lock, sem o registro das movimentacoes de estoque) → Concorrência funciona na sorte. Sem auditoria.  ·  (B) Adicionar lock pessimista + o registro das movimentacoes de estoque → Concorrência segura, trilha completa, sem perda de dados.
- **Recomendação:** Opção 2: lock + o registro das movimentacoes de estoque. Custa pouco em performance (travamento é milissegundos), mas ganha 100% de confiabilidade e auditoria.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts (sem lock pessimista, sem uma trava pra ler e gravar sem pisar um no outro)

## P167 — Não dá pra desfazer uma correção de estoque feita semana passada
- [ ] **vou fazer** · gravidade: média · tema: Cancelar e desfazer · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Operador A corrigiu um produto de 5 pra 3 na segunda-feira. Agora é sexta, descobrem que foi erro (deveria ter deixado em 5). Querem desfazer.
- **Hoje:** Sistema não tem botão de 'desfazer'. Operador poderia chamar a rota novamente com '5', mas fica parecendo um novo ajuste. Não fica claro que desfez nada. Auditoria não vê o par 'ajuste + estorno'.
- **Por que importa:** Sem estorno formal, o saldo fica correto por acaso, mas a trilha está confusa. Próxima auditoria não entende o que aconteceu.
- **Opções:** (A) Deixar sem estorno (como hoje) → Flexível, mas auditoria fica confusa quando há múltiplos ajustes.  ·  (B) Criar botão 'desfazer' com estorno formal → Rastreabilidade total: fica claro que houve ajuste e sua reversão.
- **Recomendação:** Opção 2: estorno formal. Quando operador quer desfazer, cria um novo registro que diz 'isso desfaz aquele outro'. Auditoria completa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts (sem endpoint de reverse)

## P168 — Dois cliques rápidos no botão 'Conectar MercadoLivre' causa falha na conexão
- [ ] **vou fazer** · gravidade: média · tema: Integração com a loja (Tiny / marketplace) · fluxo: Integração com MercadoLivre (Autenticação + Sincronização de Anúncios)
- **Imagina assim:** Operador clica duas vezes seguidas no botão 'Conectar conta ML'. O navegador envia dois pedidos ao mesmo tempo. Cada um cria um código de segurança diferente. Quando autoriza no ML, o navegador tem só o último código. ML retorna o primeiro código. Não batem.
- **Hoje:** Clique 1: cria código X, guarda no navegador. Clique 2: cria código Y, apaga X e guarda Y. Operador autoriza no ML e volta com código X. Sistema compara: X (que veio de ML) vs Y (que está guardado). Não é o mesmo. Falha com mensagem 'segurança inválida'. Operador precisa tentar de novo.
- **Por que importa:** Frustra o operador, parece que o sistema é quebrado. Gera suporte desnecessário ('por que falhou?'). Você perde tempo reconectando.
- **Opções:** (A) Desabilitar botão enquanto o primeiro clique está processando → Operador não consegue clicar 2x. Simples, rápido. Padrão da web.  ·  (B) Guardar múltiplos códigos temporários, aceitar qualquer um deles → Mais flexível, mas aumenta complexidade e risco de segurança.
- **Recomendação:** Desabilitar o botão durante a conexão (opção 1). É a solução mais segura e padrão em aplicações web. Leva 10 minutos pra implementar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:37-45, callback/route.ts:43-45

## P169 — Kit do Tiny vira não-kit (tipo mudou)
- [ ] **vou fazer** · gravidade: média · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Produto EX-KIT era um kit com 3 peças. Você rebaixa para 'simples' (não é mais kit) direto no Tiny. Operador sincroniza.
- **Hoje:** Sistema marca na base que não é mais kit. Mas a lista de 3 peças que estava lá (relação antiga) fica órfã no canto da base. Novo pedido que entra não vê que é kit (porque não é mais), mas a velha composição ainda existe suja no banco.
- **Por que importa:** Dados duplicados/sujos no banco. Se algum dia alguém ou outro processo tentar usar aquela velha composição, pode sair separando peças que não deveria.
- **Opções:** (A) Deixar a composição antiga lá (suja) → Banco fica desorganizado. Risco de algum processo usá-la por engano.  ·  (B) Quando mudar de kit para não-kit, apagar automaticamente a composição antiga → Banco limpo. Quando voltar a ser kit depois, começa do zero.  ·  (C) Avisar ao operador que há composição suja e deixar ele escolher limpar → Transparente. Operador decide se importa ou não.
- **Recomendação:** Apagar automaticamente. Quando tipo muda, limpe a velha composição.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

## P170 — Produto com múltiplos mapeamentos (2 empresas)
- [ ] **vou fazer** · gravidade: média · tema: Integração com a loja (Tiny / marketplace) · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Mesmo produto mapeado em 2 contas/empresas diferentes no Tiny (A e B). Operador sincroniza sem escolher qual.
- **Hoje:** Sistema pega aleatoriamente uma das 2 (a ordem depende de como banco respondeu, pode mudar cada vez). Pode trazer dados de A uma vez, dados de B outra vez. Último dado que entrou vence, sobrescreve o anterior.
- **Por que importa:** Quando operador roda sincronização 5 vezes, pode ter 5 resultados diferentes cada vez. Estoque fica imprevisível. Preço muda, descrição muda — ninguém sabe qual versão é verdade.
- **Opções:** (A) Deixar como está (aleatório) → Comportamento imprevisível. Operador nunca sabe qual versão entrou.  ·  (B) Exigir que operador escolha qual empresa sincronizar, depois sempre usar aquela → Determinístico. Sempre mesmos dados. Um pouco mais de clique no operador.  ·  (C) Se houver múltiplos, mostrar aviso e aguardar escolha do operador → Mesmo que acima, mas explícito — operador vê que tem ambiguidade.
- **Recomendação:** Exigir escolha do operador. Nunca sincronize aleatoriamente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

## P171 — Produto sem nenhum mapeamento Tiny nunca sincronizado
- [ ] **vou fazer** · gravidade: média · tema: Integração com a loja (Tiny / marketplace) · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Produto MANUAL-CADASTRO criado direto no seu sistema, sem nunca ter sido linkado ao Tiny. Operador clica sincronizar.
- **Hoje:** Sistema procura mapeamento, não acha (vazio), avisa no log e sai sem fazer nada. Operador vê que 'executou' mas sem feedback claro se entrou ou não. Parece 'ok' mesmo tendo feito nada.
- **Por que importa:** Operador quer sincronizar produto novo mas sistema não faz (porque não tem mapeamento) e não avisa claramente. Deixa operador em dúvida.
- **Opções:** (A) Deixar como está (silencioso) → Operador confuso, pensa que sincronizou quando não sincronizou.  ·  (B) Avisar com clareza que produto não tem mapeamento Tiny (erro, não aviso) → Operador vê logo que precisa mapear antes.  ·  (C) Oferecer criar mapeamento automaticamente no Tiny durante a sincronização → Mais inteligente, menos clique. Mas pode ser arriscado se dado for incompleto.
- **Recomendação:** Avisar claramente que falta mapeamento. Operador precisa ver que não sincronizou.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

## P172 — Código da prateleira com caracteres estranhos (números e letras misturadas)
- [ ] **vou fazer** · gravidade: média · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Criar, editar e remover prateleiras
- **Imagina assim:** Operador digita 'LOC@123' ou 'A B' (com espaço) como código de uma prateleira. O sistema salva assim mesmo.
- **Hoje:** Não há validação — o sistema deixa salvar código com símbolos (@, espaço, etc.). O código entra no banco de dados com caracteres inválidos e depois pode quebrar sistemas que dependem desse código.
- **Por que importa:** Sistemas que leem esse código (como impressora de etiquetas) podem não entender '@' ou espaço e gerar erros. Operador tenta escanear 'LOC@123' e o leitor não reconhece.
- **Opções:** (A) Deixar como está — não valida, permite qualquer caractere → Fácil no curto prazo, mas gera confusão com sistemas externos  ·  (B) Validar — só aceita A-Z, números e hífen (ex: 'A-123' sim, 'A B' não) → Seguro, mas operador que digitou errado vai ver erro e ter que digitar de novo
- **Recomendação:** Validar — adicione regra que rejeita código com espaço, @, ou outros símbolos. Mensagem: 'Use apenas letras maiúsculas, números e hífen.'
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/localizacoes/route.ts

## P173 — Novo tipo de prateleira criado, mas sistema não aceita
- [ ] **vou fazer** · gravidade: média · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Importação em lote de prateleiras
- **Imagina assim:** Alguém criou prateleiras tipo 'embalagem' no banco de dados, mas quando operador tenta criar um lote com esse tipo, o sistema rejeita.
- **Hoje:** Há inconsistência — o tipo existe no banco mas o formulário não deixa selecionar. Operador vê campo bloqueado, sem saber por quê.
- **Por que importa:** Confunde fluxo. Operador não consegue criar prateleiras do novo tipo. Sistema tem tipo no banco mas rejeita na interface.
- **Opções:** (A) Remover tipo 'embalagem' do banco de dados — deleta de lá → Formulário fica consistente, mas perde o tipo que alguém criou  ·  (B) Adicionar 'embalagem' à lista de tipos válidos no formulário → Formulário aceita, operador consegue usar
- **Recomendação:** Opção B — alguém criou por razão, deixar disponível
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts linha 8-14; page.tsx linha 16-22

## P174 — Dois cliques simultâneos no mesmo código de produto causam erro de duplicação
- [ ] **vou fazer** · gravidade: média · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** User 1 e User 2 tentam criar o produto 'PECA-001' no mesmo segundo.
- **Hoje:** O primeiro consegue. O segundo vê uma mensagem genérica de erro '400' na tela, mas não fica claro se é porque o código já existe ou se é outro problema.
- **Por que importa:** O operador fica confuso e pode tentar digitar de novo ou desistir, achando que o sistema quebrou. Além disso, sem saber exatamente qual é o problema, não consegue decidir o que fazer (procurar o produto que já existe ou tentar de novo com outro nome).
- **Opções:** (A) Mostrar mensagem específica: 'Esse código já existe. Clique aqui pra encontrá-lo na lista' → Operador consegue encontrar o produto rapidinho sem confusão.  ·  (B) Deixar como tá (erro genérico) → Operador fica em dúvida, clica de novo, gera mais erros. Perda de tempo e frustração.
- **Recomendação:** Implementar a mensagem clara. Demora 2 horas. Vale muito a pena.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 1 em corrigir

## P175 — Editar descrição de produto manualmente sem deixar rastro
- [ ] **vou fazer** · gravidade: média · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Um produto foi criado manualmente (sem vir do fornecedor). Admin vê um typo e corrige 'Vela Branca' pra 'Vela Branca de Soja' direto no sistema.
- **Hoje:** A correção é aplicada, mas ninguém fica sabendo quem fez, quando fez ou qual era o texto anterior. Se alguém questiona depois ('Quem mudou isso?'), é impossível rastrear.
- **Por que importa:** Auditoria e conformidade legal. Se aparece uma reclamação do cliente sobre dados incorretos, você precisa saber quem mexeu quando. Além disso, se vários operadores mexem no mesmo produto, fica caótico saber quem mudou o quê.
- **Opções:** (A) Ativar log de auditoria: toda edição fica registrada com quem/quando/antes/depois → Você tem 100% de rastreabilidade. Se aparecer dúvida, você sabe quem mexeu e em que momento.  ·  (B) Deixar sem log → Rápido de implementar hoje, mas amanhã quando surgir uma discrepância ou auditoria fiscal, você não consegue explicar.
- **Recomendação:** Ativar o log. Não é caro e te protege legalmente. Bloqueie também edição em campos que devem ser sincronizados automaticamente (como 'código Tiny', 'kit?', data de sincronização).
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 3 em corrigir

## P176 — Clicar duas vezes no botão sincronizar causa sincronização duplicada
- [ ] **vou fazer** · gravidade: média · tema: Tarefas automáticas e fila do sistema · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Admin clica sincronizar, a tela fica carregando. Acha que não funcinnou e clica de novo.
- **Hoje:** O sistema não bloqueia: duas sincronizações rodam em paralelo. Ambas pegam a mesma informação do fornecedor, atualizam a mesma descrição (segundo sobrescreve primeiro), deletam e refazem as relações com componentes do kit — tudo em paralelo, causando inconsistência.
- **Por que importa:** Risco de corromper dados se o kit tem múltiplos componentes. Os dois processos podem deletar e recriar de forma diferente, deixando componentes órfãos. Além disso, pura perda de processamento e lentidão.
- **Opções:** (A) Marcar produto como 'sincronizando' até terminar. Se clicar de novo, retorna 'já tá sincronizando, espere' → Só roda uma sincronização por vez. Dados saem consistentes. Admin fica tranquilo.  ·  (B) Usar data e hora: se última sincronização foi há menos de 5 segundos, rejeita → Impede duplo clique acidental. Simples de implementar.  ·  (C) Deixar como tá → Continua permitindo sincronizações paralelas. Risco permanente de dados ruins.
- **Recomendação:** Opção 1 ou 2, qualquer uma funciona. Recomendo a 1 porque é mais clara pro usuário ('tá sincronizando, aguarde').
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 4 em corrigir

## P177 — Prateleira apagada, mas contagem antiga fica órfã
- [ ] **vou fazer** · gravidade: média · tema: Cadastros (produtos, prateleiras, fornecedores) · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Um operador faz contagem na prateleira A, depois a prateleira é deletada do sistema
- **Hoje:** A contagem fica invisível — o sistema tenta procurar a prateleira pra mostrar o histórico, não encontra, e a linha desaparece
- **Por que importa:** O dono não consegue ver qual foi a última contagem real daquele produto naquela prateleira. Perde rastreabilidade do que foi conferido
- **Opções:** (A) Nunca deletar prateleira — só marcar como inativa → Histórico fica preservado. Mais linhas na tabela de prateleiras, mas dados intactos  ·  (B) Antes de deletar, transferir contagens antigas pra um arquivo de auditoria → Prateleira sai, mas cópia fica guardada. Mais complexo, precisa de tarefa manual ou automática
- **Recomendação:** Nunca deletar prateleiras. Marcar como inativa quando sair de uso. Simples, seguro, mantém rastreabilidade
- **➡️ MINHA ESCOLHA:** 
- **Código:** supabase/migrations/20260526_wms_produto_ultimas_contagens_3d.sql:62

## P178 — Reativar fornecedor deletado não traz a relação de volta com a loja
- [ ] **vou fazer** · gravidade: média · tema: Compras de fornecedor · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Você tinha o fornecedor F8 vinculado ao produto P789. Deletou por engano. Depois importa de novo os dados do Tiny (sua loja) que tem F8 lá. O vínculo deveria reaparecer automaticamente, mas fica inativo.
- **Hoje:** Quando reimporta, o sistema acha que F8 já existe (porém desativado). Em vez de reativar esse mesmo vínculo, deixa ele morto. Você teria que recriar manualmente.
- **Por que importa:** Perdi continuidade de dados: histórico de compras, lead times configurados, custo combinado. É trabalho dobro recriar tudo.
- **Opções:** (A) Reativar automático: se importa um vínculo que estava deletado, marca como ativo de novo → Recupera tudo (histórico, lead times, custo). Sem trabalho extra. Risco baixo se só reativa o que vinha do Tiny.  ·  (B) Deixar deletado, forçar recriação manual → Você tem controle total, mas é mais trabalho. Útil se quer que cada reimportação seja tipo um 'reset'.  ·  (C) Avisar mas não reativar: mostrar 'esse vínculo foi deletado, quer reativar?' → Meio termo. Você escolhe a cada vez, mas é clique a clique.
- **Recomendação:** Reativar automático. Faz sentido: se Tiny tem, você quer que o sistema tenha também.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/fornecedores.ts:244-275

## P179 — Fornecedor deletado fica ainda aparecendo nos estoque que tem vinculado
- [ ] **vou fazer** · gravidade: média · tema: Compras de fornecedor · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Fornecedor F30 está vinculado a 5 produtos diferentes, todos com estoque em prateleiras. Você marca F30 como deletado (inativo). O estoque continua aparecendo como se fosse daquele fornecedor, que não existe mais.
- **Hoje:** Quando deleta F30, só marca F30 inativo. Os 5 vínculos continuam ativos. Se alguém quer ver 'estoque de fornecedor preferencial', aparece F30 que não existe.
- **Por que importa:** Confunde quem tá trabalhando. Você vê estoque de um fornecedor que foi deletado. Qual é o estado real? É um bug de inconsistência.
- **Opções:** (A) Cascata: deletar fornecedor desativa TODOS os seus vínculos automaticamente → Limpo. Quando deleta F30, sumiram todos os 5 vínculos. Nada fica órfão. Mais seguro se tem certeza que não vai querer reverter.  ·  (B) Bloquear delete: avisar 'não posso deletar, F30 tem 5 vínculos ativos' → Força você a deletar os 5 vínculos primeiro. Mais trabalhoso, mas deixa explícito o que vai sumir.  ·  (C) Deixar como está: vínculo fica órfão mas inativo visualmente → Funciona, mas confunde. Você vê registros fantasma.
- **Recomendação:** Bloquear delete até que vínculos estejam inativos. Força a sequência certa e evita surpresas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/fornecedores.ts:73-79

## P180 — Dois operadores editam inventário ao mesmo tempo e veem dados desincronizados
- [ ] **vou fazer** · gravidade: média · tema: Inventário e acertos de saldo · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** Um operador está contando produtos em uma prateleira. Ao mesmo tempo, outro supervisor aprova uma divergência (erro encontrado no estoque). O sistema não avisa o primeiro operador em tempo real. Quando ele recarrega a página, vê que a divergência desapareceu, ficando confuso.
- **Hoje:** Hoje em CWB, 15h30: Operador A está contando e descobre que há 30 unidades mas o sistema diz 25 (diferença de +5). Marca como divergência. Ao mesmo tempo, 15h31, Operador B (supervisor) aprova essa divergência em outra aba. Operador A continua contando sem saber que o supervisor já agiu. Se recarregar a página, a divergência desaparece do seu lado.
- **Por que importa:** Operadores repetem trabalho ou ficam sem saber do status. Pode resultar em contagens duplicadas, aprovações perdidas, ou operador gastando tempo checando algo que já foi resolvido.
- **Opções:** (A) Usar notificações em tempo real: quando um operador aprova, o sistema avisa todos os outros que estão vendo aquela divergência. → Instantâneo. Operadores sempre veem a versão atual. Nenhuma confusão.  ·  (B) Manter como está mas adicionar um aviso 'Recarregue para ver atualizações' no canto da tela. → Operadores sabem que precisam recarregar, mas é manual. Menos robusto, mas mais simples de implementar.  ·  (C) Bloquear prateleira enquanto operador está contando: nenhum supervisor consegue mexer até terminar. → Isolamento total. Mais lento de trabalho, mas sem risco de confusão. Supervisor terá que esperar.
- **Recomendação:** Notificações em tempo real. Vocês já têm a infraestrutura — usar de verdade. Operador A recebe um aviso: 'Divergência aprovada' e segue com confiança.
- **➡️ MINHA ESCOLHA:** 
- **Código:** supabase/migrations/20260529_wms_inventario.sql:140-155, src/app/wms/dashboard/page.tsx

## P181 — Alarme falso: novo galpão (vazio) grita que embalagem está lenta
- [ ] **vou fazer** · gravidade: média · tema: Relatórios e indicadores · fluxo: Painel de Acompanhamento de Fluxo (produtividade e atrasos por etapa)
- **Imagina assim:** Galpão novo, criado ontem. Hoje embalou 10 pedidos em 180 minutos. Sistema compara com histórico de 30 dias (que está vazio) e grita CRÍTICO: 'embalagem 180min, esperado 0min'.
- **Hoje:** Novo galpão spinup. Histórico de 30 dias = zero pedidos embalados (não existem dados). Período de 24h = 10 pedidos em 180min. Regra: se 180min > 1.5 × (histórico), alerta. Como histórico = vazio, sistema trata como 0, compara 180 > 1.5×0 = 180 > 0 → CRÍTICO. Dispara falso. Cooldown de 4 horas evita spam, mas primeira vez já atrapalha.
- **Por que importa:** Alarmes falsos gastam atenção. Time começa a ignorar alertas porque 'sempre é falso'. Quando vem um alerta de verdade, ninguém liga. Além disso, operador que abriu o galpão fica nervoso com crítico no primeiro dia.
- **Opções:** (A) Checar: histórico tem pelo menos 10 pedidos nos últimos 30 dias? Só se SIM, roda a regra. Se não, ignora o alerta (ou avisa com nível mais baixo, tipo INFO). → Galpão novo não grita. Depois de 10 pedidos passarem, o sistema aprende e começa a comparar de verdade.  ·  (B) Usar um valor pré-configurado como 'default' pra novos galpões (ex: esperado = 120min). Compara contra esse default. → Histórico zero não mata a lógica. Mas se default estiver errado, vira outro alarme falso.  ·  (C) Deixar como está (alarme falso é ok). Time aprende a ignorar nos primeiros dias. → Mais simples, mas compromete confiança. Não recomendado.
- **Recomendação:** Opção 1: Checar se histórico tem ≥10 pedidos. Se não, não roda a comparação nesse período. Simples, efetivo, protege galpões novos.
- **➡️ MINHA ESCOLHA:** 
- **Código:** supabase/migrations/20260514_wms_insights_motor.sql:358

## P182 — Operador deletado deixa insight órfão no painel
- [ ] **vou fazer** · gravidade: média · tema: Relatórios e indicadores · fluxo: Produtividade e ranking dos operadores
- **Imagina assim:** Um operador saiu da empresa (foi deletado do sistema). Mas um insight dele ('queda de produtividade') ficou gravado. Gerente clica pra ver detalhes desse operador.
- **Hoje:** Sistema tenta buscar o operador e não encontra (foi deletado). Painel quebra ou mostra 'não encontrado'. Se o insight estiver numa lista de monitoramento, vira um link quebrado.
- **Por que importa:** Gerente fica confuso ao tentar abrir um insight que virou fantasma. Tela quebra quando tenta carregar dados de alguém que saiu.
- **Opções:** (A) Verificação no banco: quando clica no insight, consulta primeiro 'esse operador ainda está ativo?'. Se não, mostra mensagem 'operador saiu da empresa'. → Simples. Não quebra mais.  ·  (B) Limpeza automática: quando operador é deletado, remove todos os insights dele automaticamente. → Histórico limpo. Mas perde o registro de insights antigos.
- **Recomendação:** Use a verificação: pergunte ao banco se operador está ativo antes de exibir. Mantém histórico e não quebra.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/insights/pessoas/[id]/page.tsx; migration 20260515 linha ~52

## P183 — Quando muda a chave de integração, as impressoras antigas continuam funcionando por até 5 minutos
- [ ] **vou fazer** · gravidade: média · tema: Integração com a loja (Tiny / marketplace) · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Um gerente acessa a conta de integração com PrintNode, muda a chave de acesso (por segurança ou porque expirou), e clica salvar. Neste mesmo momento, um operador clica para reimprimir uma etiqueta de um pedido.
- **Hoje:** O sistema armazena em memória a última chave usada com um prazo de até 5 minutos. Quando o operador clica reimprimir, o sistema usa a chave ANTIGA (armazenada em memória) e não a chave nova que o gerente acabou de salvar.
- **Por que importa:** Se a chave antiga deixou de funcionar (foi cancelada, expirou, foi trocada por segurança), a etiqueta não imprime, e o operador não consegue enviar o pedido. Mas o gerente pensa que já corrigiu o problema ao salvar a chave nova — e demora até 5 minutos para funcionar novamente.
- **Opções:** (A) Fazer o sistema esquecer a chave antiga assim que o gerente clica 'Salvar' → Próxima impressão usa a chave nova imediatamente. Sem demora de 5 minutos.  ·  (B) Deixar como está (esperar 5 minutos é aceitável) → Operador sofre quando tenta reimprimir nos primeiros 5 minutos. Demanda chega ao suporte.
- **Recomendação:** Escolha a primeira opção. Quando muda a chave, o sistema deve esquecer a velha NA HORA. Não custa nada e evita frustração do operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/admin/printnode/contas/[id]/route.ts:14-82, src/lib/printnode.ts:281-282

## P184 — Duplo clique rápido no mesmo número (operador bate Enter duas vezes com mesma quantidade)
- [ ] **vou fazer** · gravidade: leve · tema: Inventário e acertos de saldo · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Operador digita '5' e bate Enter. Rede está lenta, tela congela. Bate Enter de novo (mesma quantidade, porque não mudou).
- **Hoje:** Tiny recebe balanço: se já é 5 e tenta seta 5 de novo, fica 5. Não repete no Tiny (sem problema). Mas se houvesse o registro das movimentacoes de estoque local, poderia gravar 2 movimentos. Sem mecanismo de chave de ID único no banco local, sistema não sabe que é retentativa.
- **Por que importa:** Se sistema tivesse o registro das movimentacoes de estoque, virava dois registros de mesmo ajuste, auditoria fica duplicada.
- **Opções:** (A) Deixar ID único só no Tiny, não no banco local → Seguro no Tiny, mas banco local fica exposto a duplicação se houver o registro das movimentacoes de estoque.  ·  (B) Adicionar chave ID único no banco local também → Dupla proteção: Tiny + banco local rejeitam duplicate. Seguro 100%.
- **Recomendação:** Opção 2: chave ID único em ambos os lados. Pequeno custo, máxima segurança.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/tiny-api.ts:553-575

## P185 — Duplo clique no botão de recarregar faz o sistema consultar o banco de dados duas vezes
- [ ] **vou fazer** · gravidade: leve · tema: Tarefas automáticas e fila do sistema · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** O painel estava em erro. O operador clica 'Recarregar' rápido duas vezes (duplo clique), ou clica várias vezes ansioso enquanto espera. O sistema envia duas requisições simultâneas para o banco. Sem problema fatal, mas desperdício de recursos e lag desnecessário.
- **Hoje:** Hoje, 14h30: painel em erro. Operador paniqueia, clica retry 2-3 vezes rápido. Banco recebe 6-9 consultas em poucos segundos quando deveria ser só 1-2. Tudo fica mais lento.
- **Por que importa:** Desperdício de energia do servidor. Em um momento de pico com 10 operadores todos clicando duplo, pode ficar lentidão desnecessária. Não causa desastre, mas é ineficiente.
- **Opções:** (A) Desabilitar o botão enquanto carrega: fica cinzento enquanto busca dados, não aceita novo clique. → Simples. Operador não consegue clicar duas vezes.  ·  (B) Manter como está. Banco aguenta. Deixar como issue baixa e resolver quando tiver tempo. → Zero esforço agora. Problema continua pequeno.
- **Recomendação:** Desabilitar o botão enquanto carrega. Uma linha de código, zero risco. Faz a experiência melhor.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/dashboard/page.tsx:59


# 🟡 DECISÕES (você escolhe) — 316


## Tema: Cancelar e desfazer (39)

### D001 — Cancelamento chega enquanto estamos separando: deixa cancelar?
- [ ] **vou fazer** · fluxo: Quando um pedido novo chega e o sistema decide de qual galpão sai
- **Imagina assim:** Pedido foi aprovado e está sendo separado na prateleira (operador pegando itens). Nesse momento chega aviso de cancelamento do cliente.
- **Hoje:** Sistema permite cancelamento. Marca pedido como 'cancelado'. Mas estoque já foi movido (ou está sendo movido). Não desfaz a movimentação. Resultado: estoque volta pro pool (porque o sistema refaz a operação de forma que não repete), mas operador que estava separando fica confuso com o pedido sumiço.
- **Por que importa:** Operador já separou 5 itens na mão, vê aviso que foi cancelado, não sabe se deve continuar ou parar. Pode gerar confusão no chão de fábrica.
- **Opções:** (A) Bloquear cancelamento se estiver em separação (pedido fica travado até terminar) → Mais seguro operacionalmente. Pode gerar reclamação de cliente (não pode cancelar no meio).  ·  (B) Permitir cancelamento a qualquer hora e lidar com confusão operacional → Cliente fica feliz (cancela a hora que quer). Operador fica confuso.  ·  (C) Permitir, mas enviar aviso extra ao operador: 'esse pedido foi cancelado, pare de separar' → Melhor experiência. Precisa de integração com o app do operador (aviso em tempo real).
- **Recomendação:** Opção 3 (ideal) ou Opção 1 (rápido). Opção 2 deixa risco.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reservas.ts:135-211

### D002 — Estoque foi parcialmente cancelado (liberou 50 de 100). Como cancelar o restante?
- [ ] **vou fazer** · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Operador marcou para cancelar 50 unidades de um pedido de 100 (por exemplo, cliente devolveu só parte). Depois precisa cancelar as outras 50.
- **Hoje:** Sistema bloqueia dizendo 'já foi cancelado parcialmente, use outro menu'. Operador não encontra esse outro menu. Fica preso.
- **Por que importa:** Se o operador quer cancelar tudo, precisa conseguir. Senão fica estoque prisioneiro — não está apartado pra pedido nenhum, mas também não está disponível pra vender.
- **Opções:** (A) Criar menu próprio 'cancelar mais' que deixa operador escolher quanto (até o restante) → Claro. Operador vê que pode cancelar mais.  ·  (B) Permitir cancelamento total mesmo com parcial anterior (faz tudo de uma vez) → Simples. Mas perde detalhe de 'cancelou em duas vezes'.
- **Recomendação:** Criar botão 'Cancelar resto' que pré-preenche a quantidade restante. Se cancelou 50, mostra 'Cancelar 50 restantes?' com um clique.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:386-392

### D003 — Posso cancelar uma transferência enquanto alguém está recebendo ela no galpão?
- [ ] **vou fazer** · fluxo: Recebimento de Estoque Transferido de Outro Galpão
- **Imagina assim:** Operador A está recebendo uma transferência de 100 teclados do galpão A para o galpão B. No mesmo instante, o gerente clica cancelar a transferência.
- **Hoje:** O sistema permite que o cancelamento aconteça. Ele estorna os itens que já foram recebidos (devolvendo pro galpão origem) e ignora os que ainda não foram. Fica um bagunço se os dois processos tentarem mexer no mesmo produto ao mesmo tempo.
- **Por que importa:** Pode sobrar estoque no lugar errado ou desaparecer quantidade. Se os 100 teclados estão no meio do recebimento, é perigoso deixar que cancelem enquanto isso acontece.
- **Opções:** (A) Permitir cancelamento: se estiver recebendo, mesmo assim deixa cancelar. Sistema tenta desembaraçar depois. → Mais flexível, mas pode deixar o estoque confuso. Precisa de alguém pra revisar depois.  ·  (B) Bloquear cancelamento se estiver recebendo: da uma mensagem tipo 'espera terminar o recebimento' ou 'clica desfazer recebimento' → Mais seguro. Força a terminar ou desfazer antes de cancelar. Operador fica sabendo que não pode fazer tudo ao mesmo tempo.
- **Recomendação:** Bloquear cancelamento. Se está recebendo, só deixa terminar ou desfazer. Evita bagunça no estoque.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Recebimento de Estoque Transferido de Outro Galpão")

### D004 — Um admin volta um pedido de 'em separação' para 'aguardando compra' — isso deveria desfazer o estoque que já foi tirado?
- [ ] **vou fazer** · fluxo: Painel de Separação de Pedidos
- **Imagina assim:** Pedido P1 estava 'aguardando compra de fornecedor'. Operador começou a separar, moveu alguns itens. Admin vê que era um erro (ex: compra foi cancelada) e clica 'Voltar para Aguardando Compra'. Os itens já separados voltam pra prateleira?
- **Hoje:** O sistema muda o status do pedido de volta pra 'aguardando compra', mas NÃO desfaz o estoque que foi tirado. Os itens continuam 'desaparecidos' do saldo.
- **Por que importa:** Se não desfizer, o estoque saldo fica errado de verdade. Quando o pessoal do galpão fizer contagem, vai faltar estoque. Causa discrepância permanente que ninguém consegue explicar depois.
- **Opções:** (A) Fazer o sistema AUTOMATICAMENTE desfazer o estoque quando volta a etapa → Estoque volta 100% correto. Admin não precisa ficar digitando reversão manualmente.  ·  (B) Admin volta a etapa, mas depois pode clicar 'Desfazer estoque separado' manualmente → Mais controle, mas exige 2 passos. Risco de admin esquecer o segundo passo.  ·  (C) Deixar como está (estoque não volta) — admin faz isso em um formulário separado se precisar → Processo separado, mas confuso. Admin não vai lembrar depois.
- **Recomendação:** Opção 1: faça automático. Quando volta a etapa, deve voltar o estoque junto. Isso garante que o saldo sempre bate com a realidade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/separacao/page.tsx:163-224, 506-528

### D005 — O sistema tem um jeito simples de DESFAZER quando a gente manda um item pro fornecedor por engano?
- [ ] **vou fazer** · fluxo: Mandar item para compra quando não tem estoque no galpão
- **Imagina assim:** Um supervisor percebe que um item estava marcado pra compra, mas encontra a mercadoria de verdade na prateleira — foi só organização errada. Ele quer voltar o item pra separação normal.
- **Hoje:** Não existe nenhum botão ou comando pra isso. O supervisor teria que pedir pra alguém entrar no banco de dados e mexer manualmente. O sistema fica confuso: o item está ao mesmo tempo marcado pra compra E marcado pra separação.
- **Por que importa:** Acontece de verdade quando a galera não acha uma caixa no lugar esperado. Perder 2 horas de produção e ter que chamar TI é muito caro. Se houvesse um botão, o supervisor resolvia em 30 segundos.
- **Opções:** (A) Criar um botão de 'Desfazer compra' que limpa tudo automaticamente e devolve o item pra fila de separação → O supervisor clica, item volta pra 'em separação', e pronto. Simples e rápido.  ·  (B) Deixar como está: quem descobrir que foi engano chama TI → Continua demorando. Mas também é mais raro, então talvez não compense criar a funcionalidade.
- **Recomendação:** Criar o botão. Não é complicado de fazer, mas vai poupar muito tempo na prática. Coloca como 'raramente usado' no manual, não precisa de grande destaque na interface.
- **➡️ MINHA ESCOLHA:** 
- **Código:** mandar-compras.ts (sem função de reverter), /api/wms/separacao/desfazer (não existe)

### D006 — O que acontece com um item que já foi mandado pro fornecedor quando o cliente cancela o pedido inteiro?
- [ ] **vou fazer** · fluxo: Mandar item para compra quando não tem estoque no galpão
- **Imagina assim:** Um item de um pedido virou uma compra com fornecedor (já foi mandado pedir ao supplier). Depois disso, o cliente muda de ideia e cancela o pedido inteiro. O sistema sabe que a compra já saiu?
- **Hoje:** Não temos certeza. O sistema provavelmente tira o item do pedido, mas se o fornecedor já mandou a nota fiscal com a mercadoria, o sistema pode confundir tudo e contar o estoque duas vezes.
- **Por que importa:** Se essa situação acontecer, a gente perde rastreabilidade: o estoque fica errado no sistema. E se o fornecedor entrega mesmo assim, o sistema não sabe se deve aceitar ou devolver.
- **Opções:** (A) Quando cancela um pedido, checar se tem compra ativa com fornecedor. Se ainda não chegou nada: cancela tudo limpo. Se já chegou mercadoria: força o usuário a fazer uma devolução explícita pro fornecedor. → Fica claro pra galera: 'sua compra foi cancelada mas o fornecedor já mandou — tem que devolver'. Sem confusão.  ·  (B) Deixar o sistema recusar (rejeitar) qualquer nota fiscal que chegue de uma compra já cancelada → Garante que a mercadoria não entra no estoque. Mas o fornecedor pode reclamar — vai dar trabalho.  ·  (C) Deixar como está: confiar que isso é muito raro → Risco de erro de estoque quando acontecer. Mas se acontecer 1 vez por ano, talvez não compense arrumar.
- **Recomendação:** Ir com a opção 1: automatizar o bloqueio de entrada quando a compra foi cancelada. Protege o estoque com menos trabalho manual. Depois faz um treinamento rápido da galera: 'se cancelar pedido e já tinha compra ativa, o sistema avisa — aí você faz a devolução pro fornecedor'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** mandar-compras.ts:25-31 (docs menciona 'legado'), /api/wms/pedidos/cancelar (não lido)

### D007 — O que fazer se a devolução falha no meio do caminho?
- [ ] **vou fazer** · fluxo: Cancelamento de Separação
- **Imagina assim:** Operador clica em Cancelar para pedido com 5 itens. Devolução de 2 funciona, devolução do 3º falha (conexão cai).
- **Hoje:** Sistema devolve parcialmente (2 itens ok, 3 retidos). Pedido fica marcado como cancelado. Se operador clicar de novo, devolve o resto.
- **Por que importa:** Você precisa decidir: é aceitável ficar 'meio-cancelado'? Ou deve garantir tudo-ou-nada?
- **Opções:** (A) Best effort — devolve o que conseguir, operador reprocessa se sobrar → Mais flexível; precisa vigilância manual  ·  (B) Tudo-ou-nada — ou devolve TODOS, ou nenhum → Seguro; estoque nunca fica em estado intermediário confuso
- **Recomendação:** Escolha a Opção 2 se conseguirem implementar. Garante estoque limpo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** cancelar/route.ts:76-92

### D008 — Quando um operador quer desfazer a embalagem de um pedido dias depois, devemos permitir?
- [ ] **vou fazer** · fluxo: Embalagem de pedidos e impressão de etiqueta
- **Imagina assim:** Um pedido foi embalado e marcado como 'pronto para envio' uma semana atrás. Agora o operador quer abrir de novo — o cliente cancelou a compra ou pediu mudança de endereço.
- **Hoje:** O sistema rejeita. Diz 'pedido já foi embalado, não dá pra voltar pra embalagem'. O operador tem que desfazer item por item (clica 100 vezes pra um pedido com 100 unidades).
- **Por que importa:** Cancelamento é comum. Se ficar caro (100 cliques), operador não faz direito, pedido fica com saldo errado. Ou embalado fica congelado porque é muito trabalho desfazer.
- **Opções:** (A) Permitir 're-abrir embalagem' em um clique, desde que a marca de estoque já baixado não tenha acontecido ainda → Rápido. Operador desfaz com 1 clique. Precisa saber: o saldo foi lançado (saiu do seu controle)? Se sim, você precisa comunicar ao sistema que cancelou.  ·  (B) Forçar desfazer item por item (como é agora) → Seguro: cada item checado. Caro em tempo. Operador recusa refazer se houver 50+ itens.  ·  (C) Permitir re-abertura APENAS se a marca de estoque já baixado ainda não aconteceu (a etapa do pedido=embalado, mas a marca de estoque já baixado=falso) → Meio termo. Se lançou, rejeita (vai ser caro de reverter). Se não lançou, 1 clique resolve.
- **Recomendação:** Opção 3: permitir re-abertura se a marca de estoque já baixado ainda não aconteceu. Cobre 90% dos casos (cancelamento no mesmo dia). Para cancelamentos antigos, desfazer item por item é aceitável (raro).
- **➡️ MINHA ESCOLHA:** 
- **Código:** reiniciar/route.ts:38-86; desfazer-bip/route.ts:121-145

### D009 — Se o operador terminou um pedido e depois descobriu que foi tudo errado, consegue voltar atrás?
- [ ] **vou fazer** · fluxo: Conclusão de pedido de compra após recebimento completo
- **Imagina assim:** Pedido foi concluído (estoque saiu, tudo marcado como 'pronto'). Operador percebeu que separou SKU errado ou QC reprovou. Quer reverter pra picking novamente.
- **Hoje:** Sim, dá pra voltar. Operador usa um botão de 'desfazer' (ou na aba admin muda a etapa). Sistema inverte o lançamento de estoque (tira a saída, recoloca o produto como disponível) e recria a reserva do pedido.
- **Por que importa:** Garante que não fica item perdido se der erro. Estoque volta ao lugar certo e pedido fica aberto pra tentar de novo.
- **Opções:** (A) Deixar como está: Sistema não oferece desfazer. Se errou, tem que corrigir manual via admin (entrada/saída manual). → Simples, mas operador fica pedindo admin toda hora. Bagunça auditoria.  ·  (B) Desfazer automático: Clica um botão, sistema volta tudo (estoque + pedido). Recriar a reserva. → Mais rápido. Mas precisa que desfazer funcione corretamente (se clicar 2 vezes, não duplica inversão).  ·  (C) Desfazer parcial: Sistema volta o estoque, mas marca o pedido como 'cancelado por QC' pra rastrear. Não recriar reserva automaticamente. → Mais controle, menos riscos. Mas requer que operador recrie a reserva manual (se quiser tentar de novo).
- **Recomendação:** Desfazer automático (como está agora) é bom. Mas valida que o estoque volta certo e nenhum item fica perdido entre tabelas. Não muda nada agora, só acompanha quando operador usa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** /cutover.ts:165-375

### D010 — Depois de cancelar um item, dá pra descancar (colocar em ativo de novo)?
- [ ] **vou fazer** · fluxo: Cancelamento de item de compra de fornecedor
- **Imagina assim:** Item foi marcado pra cancelamento, depois cancelado de verdade. Dias depois descobre que foi engano e quer reativar o item.
- **Hoje:** Sistema não permite voltar de um cancelamento confirmado. Cancelamento é um estado final — não tem botão de 'desfazer' ou 'reativar' na interface.
- **Por que importa:** Se o operador se arrependeu depois de cancelar, não tem forma de consertar sem intervenção manual de supervisor ou diretamente no banco.
- **Opções:** (A) Deixar cancelamento ser terminal (não tem volta) → Operador precisa deixar claro antes de confirmar. Se errou, precisa de supervisor pra consertar no banco. Força mais cuidado.  ·  (B) Adicionar botão de 'Reativar' que volta o item pra ativo → Mais flexível, mas reduz o peso da decisão de cancelar. Pode incentivar cliques errados.  ·  (C) Permitir volta só se cancelamento pendente (antes de confirmar). Depois de confirmado, é terminal. → Compromisso: da margem pra desistir antes da confirmação final, mas confirmação é irreversível.
- **Recomendação:** Deixar como terminal. Cancelado é cancelado. Força operador a pensar bem antes de clicar em confirmar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/devolver/route.ts procura por status de cancelamento

### D011 — O que fazer se dois operadores clicam em desfazer no mesmo instante (na mesma transferência)?
- [ ] **vou fazer** · fluxo: Desfazer o recebimento de uma transferência entre galpões
- **Imagina assim:** Operador A e Operador B recebem a mesma transferência, descobrem erro, e clicam em desfazer simultaneamente (no mesmo segundo, por acaso, ou porque nao viram a notificação um do outro).
- **Hoje:** O sistema nao trava ninguém. A recebe a instrução, começa a devolver estoque. B também recebe, vê que pode desfazer (porque A ainda nao terminou), e começa a devolver o mesmo estoque de novo. Resultado: estoque voltado em duplicata pro monte. Sistema tenta se proteger: quando B tenta devolver a movimentação que A ja devolveu, o sistema vê 'essa movimentacao ja foi devolvida' e ignora (pula pra próxima). Se B conseguir fazer tudo igualmente, o saldo acaba com menos mercadoria do que deveria (porque B 'vendeu' estoque que nao tinha).
- **Por que importa:** Dois cliques simultâneos nao sao tao raros em galpão (especialmente se a pessoa nao viu notificação, ou se dois turnos diferentess estao limpando fila de tarefas). Se o sistema deixa desfazer duas vezes, o estoque fica errado. Pode vender produto que ja 'voltou', ou contar menos do que tem.
- **Opções:** (A) Travar a transferência: quando A clica desfazer, trava a transferência pra ninguém mexer ate A terminar. → B clica desfazer, sistema diz 'esperando A terminar, tente em 1 min'. Estoque nao fica duplicado. Operador tem que esperar ou tentar de novo depois.  ·  (B) Permitir que ambos tentem, mas reverter se houver conflito. → Ambos começam, mas o sistema detecta e desfaz a ação de B automaticamente. Mais complexo, risco de dados ficarem em estado confuso por um instante.  ·  (C) Usar a proteção que já existe: quando B tenta devolver a mesma movimentação, o sistema ignora (ja foi) e só faz no resto. → Funciona se todas as movimentações da transferência ja foram devolvidas por A. Se apenas algumas foram, B pode conseguir desfazer o resto, deixando a transferência meio-desfeita.
- **Recomendação:** Usar opção 1 (travar). E' a mais simples e clara pro operador. Deixa alguém esperando alguns segundos, mas garante que nao há confusão. Se dois cliques acontecem, apenas um vira sucesso, o outro falha de forma clara ('em progresso, tente depois').
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Desfazer o recebimento de uma transferência entre galpões")

### D012 — Vale a pena deixar desfazer um recebimento que é de muito tempo atrás (semanas ou meses)?
- [ ] **vou fazer** · fluxo: Desfazer o recebimento de uma transferência entre galpões
- **Imagina assim:** Uma transferência foi recebida há 30 dias. Ontem, o operador descobriu que a quantidade estava errada (ou veio o produto errado). Hoje, clica em desfazer recebimento.
- **Hoje:** Sistema nao checa quanto tempo passou. Busca a mercadoria, devolve pro monte. Mas: a mercadoria ja saiu de lá (foi vendida, ou separada pra outro pedido). Quando o sistema tenta voltar, o saldo fica negativo. Uma funcao interna do sistema vê quantidade negativa e rejeita a operação com erro 'estoque insuficiente'. Cliente no final vê erro 500.
- **Por que importa:** Se desfazer é permitido depois de semanas, pode desorganizar estoque que ja foi vendido ou movimentado várias vezes. Criar um rastro confuso (pedido A comprou, pedido B comprou novamente, depois volta pro estoque de A). E' mais seguro não permitir desfazer antiga mercadoria, porque ninguém consegue garantir de cabeça que nada foi vendido no meio do caminho.
- **Opções:** (A) Permitir sempre: deixa desfazer em qualquer momento, mas pede pra supervisor ou gerente confirmar. → Operador nao consegue sozinho (tela pede aprovação). Gerente vê que é velho, pode pedir pra resolver manualmente ou documentar como ajuste no inventário. Mais seguro, mais burocracia.  ·  (B) Bloquear desfazer se passou de N dias (ex: 7 ou 14 dias): sistema diz 'muito velho, nao posso desfazer, fale com gerente'. → Operador sabe que tem que fazer diferente (ajuste manual, ou supervisor desfaz). Nao cria saldo negativo. Mas precisa conhecer a regra (ninguém sabe disso hoje).  ·  (C) Deixar desfazer, mas avisar que pode ficar saldo negativo, e pedir pro operador conferir estoque antes. → Mais trabalho pro operador (conferir se produto foi vendido), mas permite resolução rápida se ele confirmar. Risco se ele clicar sem pensar.
- **Recomendação:** Usar opção 2 (bloquear se passou de 7-14 dias). E' a mais equilibrada. Desfazer recente (dentro de um ou dois dias) é seguro (ninguém mexeu no produto ainda). Desfazer velho precisa de outra rota (conversa com supervisor, ou ajuste no inventário). Evita surpresa de 'saldo ficou negativo', porque o sistema nao deixa chegar lá.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Desfazer o recebimento de uma transferência entre galpões")

### D013 — Se o operador clica 'Cancelar' duas vezes muito rápido, o que deveria acontecer?
- [ ] **vou fazer** · fluxo: Cancelamento de transferência entre galpões
- **Imagina assim:** Operador clica 'Cancelar' em uma transferência, e 300 milissegundos depois clica de novo, por acidente ou por impaciência.
- **Hoje:** O primeiro clique cancela mesmo. O segundo clique falha e mostra erro: 'só cancelo transferências em trânsito, essa já foi cancelada'.
- **Por que importa:** Se a primeira cancela com sucesso, a segunda falha — isso é ruim? Ou é proteção? Precisa decidir: errar é aceitável, ou o sistema deveria simplesmente ignorar cliques repetidos?
- **Opções:** (A) Deixar falhar com erro (como faz hoje) → Operador vê erro na tela. Precisa entender que 'ops, já cancelei'. Se for confuso, vai confundir o operador.  ·  (B) Sistema ignora a segunda tentativa (responde OK como se tivesse feito, mas não faz nada) → Operador não vê erro. Fica mais tranquilo. Mas esconde do operador que ele clicou duas vezes.  ·  (C) Sistema bloqueia o botão por 2 segundos após o clique (evita o problema no começo) → Operador não consegue clicar duas vezes. Mais preventivo.
- **Recomendação:** Opção 1 (deixar falhar) está OK se o operador entende a mensagem. Mas se quer menos confusão, opção 3 (bloquear o botão) é melhor: evita o erro de entrada.
- **➡️ MINHA ESCOLHA:** 
- **Código:** transferencias.ts:469-473

### D014 — Se falha o desfazimento de um item durante o cancelamento, o que acontece com os outros itens já desfeitos?
- [ ] **vou fazer** · fluxo: Cancelamento de transferência entre galpões
- **Imagina assim:** Transferência tem 4 itens. Cancelo — desfaz item 1 e item 2 com sucesso. Item 3 falha (servidor cai, rede cai, etc.). O que fica em pé?
- **Hoje:** Sistema para no item 3, joga erro, e o cancelamento inteiro falha. Itens 1 e 2 ficam com o estorno já feito (fora do estoque), mas a transferência não é marcada como cancelada. Status permanece 'em trânsito'.
- **Por que importa:** Fica estado podre: alguns itens desfazem, outros não. O operador tenta cancelar de novo e fica confuso com o que já foi feito e o que não foi.
- **Opções:** (A) Tudo ou nada: se um item falha, refazer (reverter) os itens que já foram desfeitos, e não cancelar nada → Estoque volta ao normal se falhar no meio. Mas é mais lento e usa mais processamento.  ·  (B) Desfazer o máximo possível: se um item falha, marca a transferência como 'cancelada parcialmente' ou com aviso → Alguns itens voltam pro estoque, outros ficam fora. Operador vê um aviso e pode corrigir manualmente depois.  ·  (C) Deixar como está → Continua com estado podre quando falha no meio.
- **Recomendação:** Opção 2 (desfazer o máximo possível): marca como cancelada mesmo que um item tenha falhado, e deixa um aviso. Assim o operador sabe que tem coisa pra revisar manualmente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** transferencias.ts:500-512

### D015 — Se falha ao desfazer a saída de um item, o que faz: cancela tudo ou tenta aproveitar o que já foi feito?
- [ ] **vou fazer** · fluxo: Cancelamento de transferência entre galpões
- **Imagina assim:** Transferência saiu ontem com 3 itens (estoque foi tirado de Curitiba). Hoje tentam cancelar. Desfeita a saída do item 1 e 2. Item 3 falha porque o saldo ficaria negativo ou tem constraint quebrada.
- **Hoje:** Para e lança erro. Itens 1 e 2 ficam com estorno marcado (devolvido pro estoque), item 3 não. Transferência fica em 'em trânsito'.
- **Por que importa:** Estoque parcialmente revertido: confuso o que foi desfeito e o que não foi. Se operador tenta cancelar de novo, não sabe por onde começar.
- **Opções:** (A) Recusar tudo: se um item não consegue desfazer, não desfaz nenhum (reverter os 1-2) → Estoque volta 100% ao original. Mas operador precisa descobrir por que falhou (pode ser saldo negativo mesmo).  ·  (B) Desfazer só o que consegue, marcar como 'cancelada com avisos', deixar operador revisar → Itens 1-2 voltam, item 3 fica pendente. Operador sabe que tem coisa pra revisar.  ·  (C) Bloquear cancelamento se detecta que vai falhar → Sistema avisa antes: 'não consigo cancelar porque item 3 deixaria saldo negativo'. Mais preventivo.
- **Recomendação:** Opção 3: avisar antes se vai falhar. Assim operador não tenta e não deixa estoque em estado podre.
- **➡️ MINHA ESCOLHA:** 
- **Código:** transferencias.ts:516-536

### D016 — Se passa dias e o estoque muda, ainda posso cancelar a transferência?
- [ ] **vou fazer** · fluxo: Cancelamento de transferência entre galpões
- **Imagina assim:** Segunda: crio transferência Curitiba → São Paulo com 5 peças de um produto (saída lançada). Terça: galpão de Curitiba vende 3 peças do mesmo produto pra outro cliente. Sexta: tenta cancelar a transferência. Saldo de Curitiba não tem mais espaço pra devolver 5 peças.
- **Hoje:** Sistema tenta desfazer (estornar) as 5 peças. Saldo de Curitiba fica negativo (ou viola constraint). Sistema rejeita ou deixa negativo.
- **Por que importa:** Ou estoque fica negativo (errado), ou cancelamento é rejeitado e operador fica sem saber o que fazer. Transferência fica presa em 'em trânsito'.
- **Opções:** (A) Avisar antes: 'Curitiba só tem espaço pra devolver 2 peças, as outras 3 vão pra débito/pendência' → Operador escolhe: quer mesmo cancelar sabendo que fica saldo negativo? Ou quer esperar reposição?  ·  (B) Rejeitar o cancelamento se saldo ficar negativo → Sistema diz 'não posso cancelar, saldo não aguenta'. Operador precisa recompor estoque antes.  ·  (C) Deixar negativar (como hoje) → Estoque fica errado, mas cancelamento funciona. Depois operador tira mira com ajuste manual.
- **Recomendação:** Opção 1: avisar qual é o conflito. Assim operador toma a decisão com informação, em vez de erro surpresa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** transferencias.ts:451

### D017 — Se o operador registra um ajuste errado hoje e descobre uma semana depois, ele consegue desfazer? E qual é o impacto?
- [ ] **vou fazer** · fluxo: Ajuste de estoque manual
- **Imagina assim:** Dia 20 de maio: operador faz ajuste entrada +100 kg de Nylon. Dia 27 de maio: descobre que foi erro e quer desfazer esse ajuste.
- **Hoje:** O sistema permite 'estornar' a operação antiga. Ela cria um novo registro de saída (-100 kg) vinculado ao ajuste original, ambos aparecem no histórico. O saldo final fica certo. MAS: se naqueles 7 dias alguns pedidos consumiram parte ou toda aquela entrada (usaram os 100 kg para separar mercadoria), o sistema não automaticamente 'desfaz' os pedidos — só o estoque volta ao jeito de antes. Os pedidos ficam com estoque 'perdido' no histórico.
- **Por que importa:** Estorno de ajuste antigo pode deixar pedidos em estado inconsistente. Por exemplo: pedido de 50 kg foi separado usando aqueles 100 kg que agora estão sendo desfeitos. Ninguém notifica esse pedido de 'olha, seu estoque desapareceu'.
- **Opções:** (A) Permitir estorno a qualquer hora, deixar pedidos como estão (hoje) → Ajuste fica consistente. Pedidos que usaram aquele estoque ficam com inconsistência de negócio — pode estar errado mas o sistema não detecta.  ·  (B) Bloquear estorno se há pedidos que consumiram esse estoque → Força o operador a resolver pedidos antes de desfazer ajuste. Mais seguro, mas operacional mais complexo.  ·  (C) Permitir estorno e disparar alerta/revisão de pedidos afetados → Estorno acontece, mas sistema marca 'revisar esses pedidos' e alguém precisa conferir manualmente.
- **Recomendação:** Por enquanto, deixar como está (permitir qualquer hora). MAS: adicionar alerta visual no estorno mostrando 'esses X pedidos usaram esse estoque — revisar depois'. Isso avisa o operador sem bloquear operação.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:363-417

### D018 — Quando você faz um ajuste manual, como desfaz? Tem que lembrar do ID e pedir ao técnico ou tem botão na tela?
- [ ] **vou fazer** · fluxo: Desfazer um ajuste de estoque
- **Imagina assim:** Operador entrada 50 unidades por erro (era pra ser 5). Quer desfazer. Sistema devolveu um código do movimento (mov_id), mas não tem página que lista 'ajustes que fiz'. Operador tem que ir no histórico geral (o registro das movimentacoes), filtrar, procurar, copiar o ID manualmente, colar numa URL.
- **Hoje:** Não há tela de 'meus ajustes recentes'. Operador consegue desfazer via histórico (buscando manual) ou pedindo ao técnico.
- **Por que importa:** Fluxo de desfazer fica confuso. Operador pode desistir e deixar a bagunça. Risco: saldo errado vira normal (ninguém mexe porque é chato).
- **Opções:** (A) Criar página /Ajustes (como existe /Histórico, mas só ajustes manuais). Lista últimos 30 dias, coluna motivo, coluna status (ativo/desfeito), botão 'desfazer' do lado. Clica, pede motivo, pronto. → Operador vê o que fez, desfaz em 2 cliques. Tela limpa. Auditoria fica clara.  ·  (B) Deixar como está (desfazer via histórico manual). Operador experiente consegue, novo fica perdido. → Zero custo. Risco: ajustes errados ficam pra sempre.
- **Recomendação:** Opção 1. Cria página /Ajustes simples — é fácil, operador adora. Auditoria completa (quem fez quando, o que desfeito quando). Vale a pena investir 2h de desenvolvimento.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ACD-003 / decisão: UI de desfazer de ajuste

### D019 — Se alguém clica para cancelar um pedido que JÁ está cancelado, o sistema deve fazer algo?
- [ ] **vou fazer** · fluxo: Criar uma venda na mão
- **Imagina assim:** Um pedido foi cancelado há 2 dias. Hoje, alguém tenta cancelar de novo (porque esqueceu que já foi cancelado, ou um aviso automático tentou cancelar novamente).
- **Hoje:** O sistema reconhece que já está cancelado e retorna 'sucesso, nada mudou' (0 linhas de estoque restauradas). Porém, o registro de quem fez o quê registra um novo cancelamento, como se tivesse feito algo.
- **Por que importa:** Histórico limpo e confiável. Se você vê no log '5 cancelamentos do pedido X', mas foi só 1 cancelamento real + 4 tentativas de cancelamento do mesmo, fica confuso. E o registro deve refletir decisões de verdade — tentativas não precisam sujar o histórico.
- **Opções:** (A) Registrar que foi uma tentativa que não faz efeito (cancelamento de algo já cancelado, sem mudança) → Log fica claro: mostra que tentaram cancelar, mas não mudou nada. O registro de quem fez o quê fica preciso e não confunde.  ·  (B) Continuar registrando como se tivesse cancelado, mesmo que já estivesse → Histórico fica bagunçado. 5 tentativas parecem 5 ações reais.
- **Recomendação:** Marcar como tentativa que não faz efeito (ou simplesmente não registrar). O registro deve refletir decisões, não tentativas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** vendas-cancelamento.ts:56-58

### D020 — Quando cancela uma venda manual iniciada, o estoque apartado volta pra prateleira automaticamente?
- [ ] **vou fazer** · fluxo: Venda Manual (consulta de estoque + criação de pedido)
- **Imagina assim:** Vendedor criou uma venda manual, apartou 3 unidades de um produto na prateleira 1. Depois o cliente ligou, disse que não quer mais, vendedor clica 'Cancelar venda' no painel.
- **Hoje:** Não é claro no código se o sistema devolve as 3 unidades pra prateleira automaticamente ou se fica uma tarefa manual pra admin. Assume-se que existe um botão ou um script que libera, mas não confirmei se funciona.
- **Por que importa:** Se não devolver, seu saldo virtual fica errado (3 unidades presas numa venda cancelada). Cliente novo chega, você vende aquelas 3, depois descobre que não tem. Caos.
- **Opções:** (A) Deixar como está: precisa de admin clicando manual → Controle total; mas risco de esquecer e deixar presos  ·  (B) Automatizar: cancelar venda = devolver estoque em 1 segundo → Zero risco de ficar preso; mas se cliente mudar de ideia (tipo 1 minuto depois), é tarde  ·  (C) Pedir confirmação: 'Cancelar e devolver estoque?' ou 'Cancelar mas manter apartado?' → Admin escolhe caso a caso; mais flexível
- **Recomendação:** Use a opção 2 (automatizar). Quando cancela uma venda, as 3 unidades voltam em 1 segundo pra prateleira. Se o cliente mudar de ideia em 2 minutos, ele tem que fazer uma nova venda (e acha o estoque lá).
- **➡️ MINHA ESCOLHA:** 
- **Código:** reservas.ts:38-84

### D021 — E se operador atribui E cancela o pedido ao mesmo tempo?
- [ ] **vou fazer** · fluxo: Reatribuição do responsável de uma venda
- **Imagina assim:** Operador abre detalhe do pedido. Clica 'Reatribuir pra Pedro'. Ao mesmo tempo, clica 'Cancelar pedido'. Dois cliques rápidos, quase simultâneos.
- **Hoje:** Sistema processa os dois. Primeiro reatribui (Pedro fica como vendedor), depois cancela (estorno funciona, pedido muda pra cancelado). Pedido fica cancelado COM PEDRO como vendedor. Histórico mostra: 'reatribuído a Pedro' e depois 'cancelado'.
- **Por que importa:** Estoque está seguro (cancelamento funciona). Mas é esquisito — por que reatribuir alguém a um pedido que vai desaparecer? UX confusa.
- **Opções:** (A) Deixar como está — sistema permite ambas as ações → Funciona, mas operador pode confundir. 'Por que atribuí a Pedro se cancelei?'  ·  (B) A tela avisa: 'Esse pedido será cancelado — tem certeza que quer reatribuir?' → Operador vê aviso, pensa melhor, pode desistir da reatribuição.  ·  (C) O sistema por tras 'desfaz' reatribuição ao cancelar → Operador reatribui, depois cancela. Sistema volta vendedor pro anterior (ou deixa em branco). Mais automático.
- **Recomendação:** Use a opção 2 — aviso na tela. Operador decide se faz mesmo ou não. Simples e não afeta lógica de estoque.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/vendas-cancelamento.ts:27-147

### D022 — Deixar vender com quantidade zero ou sem itens?
- [ ] **vou fazer** · fluxo: Cancelamento de Vendas
- **Imagina assim:** Um pedido entra no sistema com 0 unidades de um produto ou nenhum produto listado.
- **Hoje:** O sistema não rejeita. Se chegar no banco com quantidade=0, quando o vendedor tentar cancelar, o sistema vai tentar devolver 0 unidades (o que não faz sentido).
- **Por que importa:** Um pedido com zero itens não é um pedido real. Deixar isso passar suja o histórico de vendas, confunde relatórios e pode travar o cancelamento se o sistema exigir que cada item tenha quantidade > 0 pra devolver.
- **Opções:** (A) Bloquear no momento que o vendedor tenta criar a venda (rejeitar de imediato se vê quantidade=0) → O vendedor recebe um aviso claro: 'adicione pelo menos 1 unidade de um produto'. Nenhum pedido com zero itens entra no sistema.  ·  (B) Deixar como está (sem bloqueio) → Pedidos com zero itens podem entrar. Quando o vendedor tentar desfazer, pode dar erro ou comportamento estranho (0 itens devolvidos, como era 0 mesmo).
- **Recomendação:** Opção 1. Bloquear na entrada. É mais simples prevenir um pedido furado do que lidar com os problemas dele depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** flow-055

### D023 — Quando o sistema nega um pedido inválido, qual código de erro mostrar?
- [ ] **vou fazer** · fluxo: Cancelamento de Vendas
- **Imagina assim:** Um vendedor tenta cancelar uma venda com ID que não existe (ou foi apagada).
- **Hoje:** O sistema retorna um código 400 (pedido errado/malformado) — mesma resposta que dá quando os dados enviados estão furados.
- **Por que importa:** Códigos de erro diferentes ajudam o operador e a inteligência do negócio a saber o que aconteceu. Se o sistema sempre responde da mesma forma pra tudo, fica impossível diagnosticar se foi erro do usuário ou se o pedido realmente não existe no banco.
- **Opções:** (A) Usar código 400 (continuar como hoje) → Mensagem: 'seu pedido está errado'. É vago. O vendedor não sabe se digitou errado ou se o pedido foi apagado.  ·  (B) Usar código 404 (Pedido não encontrado) → Mensagem clara: 'esse pedido não existe'. O vendedor sabe: ou o ID é inválido, ou foi deletado. Mais informação útil.
- **Recomendação:** Opção 2. Usar 404. Parece pequeno mas torna diagnósticos muito mais rápidos quando algo quebra.
- **➡️ MINHA ESCOLHA:** 
- **Código:** flow-055

### D024 — Quando desfaz uma realocação, pode desfazer só uma parte (ex: 3 de 5 caixas) ou tem que desfazer tudo?
- [ ] **vou fazer** · fluxo: Mudança de estoque entre prateleiras (reabastecimento de picking)
- **Imagina assim:** Operador realocou 5 caixas. Depois percebe que precisava mover só 3. As outras 2 estão no lugar certo — não deveria ter mexido.
- **Hoje:** Sistema só oferece opção de desfazer TUDO (as 5 caixas voltam). Pra desfazer só 3, operador teria que usar uma função manualmente — não tem botão pra isso, nem tela normal.
- **Por que importa:** Operador comete erro de pouco, mas é forçado a desfazer tudo e depois mover de novo as 2 certas. Demora mais, confunde a separação dos pedidos.
- **Opções:** (A) Deixar como está: só desfaz tudo (as 5) → Simples, sem mudança. Operador refaz o trabalho das 2 certas depois. Mais lento.  ·  (B) Adicionar opção: 'quantas caixas você quer desfazer?' — operador digita 3, só as 3 voltam → Rápido e preciso. Operador não precisa refazer. Mais código, mas bem mais útil.
- **Recomendação:** Escolha a segunda. Operador economiza tempo e não perde o controle. Vale o código.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:664-679

### D025 — Quando alguém quer refazer uma realocação que fez dias ou semanas atrás, o sistema deixa desfazer?
- [ ] **vou fazer** · fluxo: Desfazer uma realocação dentro do galpão
- **Imagina assim:** Cenário 1: Uma realocação de mercadoria foi feita há 7 dias. O operador percebe que foi um erro. Tenta desfazer hoje.
- **Hoje:** O sistema deixa desfazer. Ele busca todos os movimentos de 7 dias atrás e devolve a mercadoria pro lugar original.
- **Por que importa:** Se não houver limite de tempo, um operador pode tentar refazer uma realocação muito antiga e entrar em conflito com outras movimentações que aconteceram desde então (outro operador já tirou aquela mercadoria, vendeu, etc). Só assim você evita confusão e saldos errados.
- **Opções:** (A) Deixar desfazer para sempre → Operador pode refazer até realocações muito antigas. Risco alto: mercadoria pode ter sido vendida ou movida várias vezes desde então.  ·  (B) Bloquear desfazer após X dias (exemplo: 7 dias) → Operador só consegue refazer erros recentes. Mais seguro, mas se ele descobrir um erro depois o sistema não deixa corrigir.  ·  (C) Deixar desfazer sempre, mas avisar do risco → Sistema mostra na tela: 'Atenção: essa realocação é de 7 dias atrás. Mercadoria pode ter sido vendida.' Operador clica por sua conta e risco.
- **Recomendação:** Se realocações muito antigas causam mais confusão do que ajudam, bloqueie após 7 dias. Se operadores precisam refazer erros descobertos tarde, deixe desfazer sempre com aviso em vermelho na tela. Qual é o padrão hoje no seu dia a dia: precisa-se desfazer realocações antigas?
- **➡️ MINHA ESCOLHA:** 
- **Código:** movimentacoes.ts:646-680

### D026 — Quando uma realocação move vários produtos diferentes de uma vez, se der erro no meio do caminho, o que fazer com os que já foram refazidos?
- [ ] **vou fazer** · fluxo: Desfazer uma realocação dentro do galpão
- **Imagina assim:** Cenário 2: Sistema realoca 3 produtos diferentes em um só comando: 5 unidades do Produto A, 3 unidades do Produto B, 2 unidades do Produto C. Tudo junto. Operador tenta refazer essa realocação em bloco.
- **Hoje:** Sistema tenta refazer um por um. Se o Produto A funciona e o Produto B falha no meio do caminho, o Produto A já foi desfeito mas o Produto B fica pela metade — desfazer do C nunca acontece.
- **Por que importa:** Deixa o estoque inconsistente: alguns produtos voltaram pro lugar original, outros ficaram no lugar errado. Saldos batem errado. Só depois você descobre que parte do desfazer funcionou e outra não.
- **Opções:** (A) Desfazer tudo junto (tudo ou nada) → Se qualquer produto falhar, nenhum volta. Mais seguro: ou desfaz completo ou fica como está. Operador sabe exatamente qual é a situação.  ·  (B) Desfazer um por um (como hoje) → Mais rápido, mas se falhar no meio deixa estoque quebrado. Precisa de reconciliação manual depois.  ·  (C) Desfazer até falhar, depois pedir confirmação → Sistema desfaz o que consegue e avisa: 'Produto B falhou. Já desfiz A. Quer refazer o resto manualmente?'
- **Recomendação:** Use 'tudo ou nada': se um produto falhar, cancela a operação inteira e nada muda. Assim fica claro: ou a realocação inteira se desfaz ou fica tudo como estava. Ninguém descobre depois que ficou meio desfeito.
- **➡️ MINHA ESCOLHA:** 
- **Código:** migration 20260527 line 48-100, movimentacoes.ts:664-679

### D027 — O sistema permite refazer uma realocação se a prateleira de destino já foi esvaziada por outro fluxo (venda, separação)?
- [ ] **vou fazer** · fluxo: Desfazer uma realocação dentro do galpão
- **Imagina assim:** Cenário 3: Sistema realocou 5 unidades para a prateleira A-01-02. Depois um operador faz separação manual e tira 3 unidades de A-01-02 para uma venda. Agora A-01-02 tem só 2 unidades. Depois tenta refazer a realocação inteira.
- **Hoje:** Sistema tenta tirar 5 unidades de A-01-02 pra voltar pra origem. Mas tem só 2. Sistema nega: 'Erro: saldo insuficiente. Não consigo tirar 5 de uma prateleira com 2.'
- **Por que importa:** Significa que a realocação virou realidade: aquelas 5 unidades realmente saíram de lá. Só 2 ainda estão lá, as outras 3 foram vendidas. Refazer a realocação inteira não faz sentido — você não pode devolver pra origem o que já foi vendido.
- **Opções:** (A) Bloquear refazer: avisar 'não dá, estoque foi usado' → Operador tem que aceitar que o erro virou realidade. Se precisa corrigir, faz ajuste manual depois.  ·  (B) Refazer parcial: só devolve o que tá lá (2 unidades em vez de 5) → Sistema devolve automaticamente o que consegue. Mas deixa dúvida: e as 3 unidades que faltam, pra onde vão?  ·  (C) Refazer e deixar saldo negativo temporário → Sistema força: tira 5 de A-01-02, deixando -3. Depois você reconstrói o histórico. Muito confuso.
- **Recomendação:** Bloqueie o refazer se não tiver estoque suficiente. Avise: 'Essa realocação virou real: 2 unidades estão em A-01-02, 3 foram vendidas. Você quer refazer só as 2 que restam?' Deixe a escolha com o operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ledger.ts:170-175, migration 20260520b line 97-98

### D028 — Quando um pedido chega sem a peça em estoque, o sistema deveria sugerir uma peça equivalente automaticamente ou fica tudo manual?
- [ ] **vou fazer** · fluxo: Busca de peças equivalentes e compatibilidades
- **Imagina assim:** Pedido de 10 freios BRAKE-A. Consulta o saldo: 0 unidades em Curitiba. Sistema sabe que BRAKE-B é equivalente e temos 20 BRAKE-B em estoque.
- **Hoje:** Operador aprova o pedido de BRAKE-A, sistema marca como sem estoque. Ninguém procura BRAKE-B. Operador tem que pedir manualmente ao roteador: 'será que BRAKE-B serve?'. Sem automação.
- **Por que importa:** Vende mais. Se a gente soubesse que BRAKE-B é equivalente e tem estoque, completa o pedido em vez de deixar parado. Cliente fica feliz. Sem essa sugestão, perdemos venda ou custa horas de operador garimpando catálogo.
- **Opções:** (A) Manter como está: operador descobre equivalentes manualmente consultando a tabela de produtos. → Lento, depende de quem conhece a tabela. Muitos pedidos ficam sem estoque mesmo tendo equivalente.  ·  (B) Sistema checa equivalentes no momento da aprovação do pedido — se BRAKE-A=0, mostra: 'Tem 20 BRAKE-B disponível, quer usar?' → Operador vê a sugestão na hora e decide rápido. Aumenta conversão. Ainda é decisão humana.  ·  (C) Sistema auto-substitui: se BRAKE-A=0, automaticamente roteia BRAKE-B em vez de deixar parado. → Mais rápido. Risco: cliente recebe BRAKE-B e não estava esperando (precisa aceitar no cadastro que são intercambiáveis).
- **Recomendação:** Opção 2: mostrar a sugestão na hora que operador aprova o pedido, deixando a escolha clara. Depois, se funcionar bem, passa pra opção 3 para pedidos específicos (ex: marcas 'intercambiáveis no cadastro').
- **➡️ MINHA ESCOLHA:** 
- **Código:** Nenhuma integração entre cross-selling (módulo isolado) e order-flow encontrada. Cross é read-only pra operador editar metadados.

### D029 — Se o operador clicar em 'cancelar pedido' depois que o sistema já liberou dele pra começar a separação, o cancelamento sai ou falha?
- [ ] **vou fazer** · fluxo: Quando estoque chega, ligar de novo os pedidos presos esperando compra
- **Imagina assim:** Pedido 1 foi aprovado pela compra, sistema liberou (criou apartados na prateleira A). Operador clica em cancelar porque loja pediu cancel. Nesse momento, o pedido já passou da fase inicial de validação.
- **Hoje:** Sistema verifica se o pedido está na fase inicial (validação ou aguardando compra). Se já avançou (ex: apartado, aguardando Nota Fiscal), o cancelamento pode falhar com erro genérico ou simplesmente não funcionar como esperado.
- **Por que importa:** Loja cancela pedidos em tempo real. Se sistema não conseguir desfazer após ter liberado pra separação, o operador fica confuso: pedido aparece como ativo no sistema, mas loja não quer mais. Risco de gerar devolução depois.
- **Opções:** (A) 1. Impedir cancelamento após liberação (bloquear, lançar erro) → Operador não consegue cancelar no sistema. Precisa de suporte ou procedimento manual. Pedido físico fica guardado.  ·  (B) 2. Permitir cancelamento mas devolver o apartado automaticamente → Pedido muda pra 'cancelado', estoque apartado volta pro montão. Simples, mas pode haver dados 'órfãos' se o cancelamento parou no meio.  ·  (C) 3. Criar etapa de 'cancelamento em progresso' com auditoria → Operador cancela, sistema registra quem e quando. Apartado é devolvido gradualmente, com trace de cada ação.
- **Recomendação:** Opção 2: permitir cancelamento com devolução automática do apartado. Mas antes, fazer anotação de quem cancelou e quando. Assim é simples pra operador e deixa rastro caso precise revisar depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts

### D030 — Um item do pedido foi cancelado no marketplace depois de ser aprovado aqui. O que o sistema deveria fazer?
- [ ] **vou fazer** · fluxo: Reconciliação de pedidos quando entra estoque novo
- **Imagina assim:** Pedido PED111 com 3 itens, todos aprovados, começou a separação (operador já pegou item 1 e 2 da prateleira). Depois de 10 minutos, marketplace manda aviso: 'cancelado item 2'. Você quer remover item 2 do pedido — devolve aquele estoque pro monte.
- **Hoje:** Sistema tenta apagar item 2 da lista de pedidos. MAS item 2 já tem movimento de saída (operador pegou). Sistema tem uma trava no banco: não deixa apagar. Aviso retorna erro, item 2 fica 'congelado' — não sai de verdade, mas tbm não volta pro sistema.
- **Por que importa:** Produto fica preso. Operador vai terminar de separar item 2 thinking está correto, embalará uma mercadoria que não deveria estar ali. Cliente recebe item 2, mas cancelou — precisa devolver depois, dor de cabeça.
- **Opções:** (A) Bloquear cancelamento: UI não deixa cancelar item que já foi separado (prevenir antes) → Operador vê mensagem 'item em separação não pode ser cancelado' — avisa marketplace que não dá. Mais seguro, mas precisa avisar cliente que vai receber mesmo assim. Cria tensão.  ·  (B) Permitir cancelamento: se item foi meio-separado, cria uma nota de retorno automática → Item sai do pedido, segue pra retorno já mapeado. Cliente recebe, já sabe que é pra devolver. Processo fica automático, mas precisa ter UX clara na embalagem.  ·  (C) Deixar como está (trava do banco, sem tratamento) → Item fica órfão, confusão operacional, cliente recebe coisa que cancelou e reclama. Sem resolver.
- **Recomendação:** Escolha opção 1 até você ter UX clara pra retorno automático (opção 2). Por enquanto: UI avisar na tela 'não dá cancelar item que está sendo separado', marketplace nega cancelamento, manda msg pro cliente 'item já foi iniciado, vai chegar do mesmo jeito'. Evita 90% da confusão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** webhook-processor-wms.ts:565-576 + schema FK's em siso_pedido_item_realocacoes

### D031 — O que fazer quando operador tenta desfazer estorno 2 vezes?
- [ ] **vou fazer** · fluxo: Entrada de estoque — como o sistema registra quando mercadoria chega
- **Imagina assim:** Operador estorna um movimento (exemplo: recebimento errado). Depois, acidentalmente clica de novo em 'desfazer estorno'.
- **Hoje:** Sistema rejeita com erro ('já foi desfeito').
- **Por que importa:** Experiência do operador. Mensagem de erro deixa confuso. Melhor seria aceitar 2º clique sem piorar as coisas.
- **Opções:** (A) Aceitar 2º clique e retornar o ID do 1º estorno (faz uma vez só) → Operador clica 2x e nada piora. Sistema retorna 'já foi desfeito' com o ID da 1ª vez. Melhor UX.  ·  (B) Rejeitar com mensagem clara ('já desfeito em [horário]') → Operador vê erro mas recebe informação de quando foi desfeito. Menos confuso que 'erro genérico', mas ainda é erro.
- **Recomendação:** Aceitar 2º clique (faz uma vez só). Operador clica 2x por acidente? Não piora nada.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:379-384, src/app/api/wms/ajuste/[id]/estornar/route.ts:42-46

### D032 — Quando um operador tenta devolver só parte de uma entrada, o que fazer?
- [ ] **vou fazer** · fluxo: Relatório de quantidade em estoque por empresa
- **Imagina assim:** Chegou uma compra com 100 unidades. O operador quer devolver 50 delas (talvez vieram erradas ou com defeito).
- **Hoje:** O sistema bloqueia. A operação não consegue executar — retorna erro. Os 100 itens continuam contando no estoque como se nada tivesse acontecido.
- **Por que importa:** Mercadorias chegam erradas ou com problemas. O dono precisa poder descontar só o que é ruim, não precisa descontar tudo para fazer ajuste. Se isso não for possível, força correções lá por trás, perdendo rastreabilidade de quanto entrou de verdade.
- **Opções:** (A) Permitir devolver parcialmente: o sistema desconta só as 50 unidades que o operador marca como 'devolver'. → Estoque fica correto (50 saem, 50 ficam). Sistema deixa tudo registrado. Mais flexível para erros na entrega.  ·  (B) Manter como está: devolução é tudo ou nada. Se 50 estão ruins, o operador inventa um jeito na mão (nota manual, depois ajusta geral). → Estoque bate no final, mas o rastro de movimentação fica sujo. Ninguém sabe depois se aqueles 50 ruins foram pra onde.  ·  (C) Proibir entrada parcial: obrigar o fornecedor a mandar correto ou forçar rejeição integral na chegada. → Menos problemas depois, mas mais luta com fornecedores agora.
- **Recomendação:** Permitir devolução parcial (opção 1). É padrão em estoque. Você perde tempo hoje ajustando manualmente se não fizer. O sistema já tem a logica guardada num canto — só precisa ligar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ledger.ts:386-391

### D033 — Se uma contagem foi aplicada e depois cancelada, o que mostrar no histórico?
- [ ] **vou fazer** · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Operador contou 25 un, a contagem virou movimento de ajuste (saldo ficou 25). Depois o supervisor cancelou a contagem. Divergência voltou pro estado pendente
- **Hoje:** Sistema mostra a contagem como se estivesse pendente novamente. Não deixa claro que foi aplicada e depois revertida
- **Por que importa:** Auditoria fica confusa. Parece que a contagem nunca foi aplicada, quando na verdade foi e foi desfeita. Dificulta rastrear por que a contagem sumiu
- **Opções:** (A) Marcar contagens canceladas como 'REVERTIDA em [data]' — mostrar estado original e o que mudou → Histórico completo e honesto. Auditor entende o caminho  ·  (B) Esconder contagens revertidas (mostrar só as ativas) → Mais limpo, mas perde auditoria  ·  (C) Deixar como está → Sem mudança
- **Recomendação:** Opção 1: mostrar que foi revertida e quando. Se supervisão cancelou, mostrar quem e por quê. Rastreabilidade completa
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/inventario.ts:1161-1226

### D034 — Auto-cadastro deveria ter um botão de 'desfazer'?
- [ ] **vou fazer** · fluxo: Auto-cadastro de fornecedores
- **Imagina assim:** Operador acidentalmente executou auto-cadastro em ambiente de teste. 13 fornecedores foram criados por engano. Quer desfazer tudo.
- **Hoje:** Não há desfazer. Única opção é desativar cada fornecedor manualmente um por um na interface.
- **Por que importa:** Auto-cadastro é operação pesada (cria muitos registros de uma vez). Se der errado, operador perde muito tempo remediando. Ou pior: dados de teste ficam junto com produção.
- **Opções:** (A) Adicionar confirmação antes: "Vai criar X novos fornecedores. Tem certeza?" → Evita acidentes. Operador pensa duas vezes antes de clicar.  ·  (B) Permitir desfazer tudo que foi criado de uma vez → Se deu errado, um clique remove tudo. Rápido.  ·  (C) Deixar como está: desativar um por um → Funciona, mas trabalhoso. Se criou 13 errados, desativa 13 vezes.
- **Recomendação:** Adicione ambas: primeiro uma confirmação clara mostrando quanto vai criar, depois permita deletar tudo de uma vez se foi erro. Protege operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/fornecedores/[id]/route.ts:114-122

### D035 — Quando uma empresa é desativada, o que fazer com os pedidos que estão na fila?
- [ ] **vou fazer** · fluxo: Controle de Empresas, Filiais e Galpões
- **Imagina assim:** NetAir é desativada (admin marca como inativa). Tem 5 pedidos esperando roteamento e 3 pedidos já em separação. Um novo pedido de NetAir chega no sistema.
- **Hoje:** O sistema rejeita novos pedidos da empresa inativa (não encontra a empresa, retorna erro). Mas pedidos que já estavam na fila continuam sendo processados normalmente, como se a empresa estivesse ativa.
- **Por que importa:** Se a empresa está desativada, pode ser porque saiu do negócio, cancelou a conta, ou virou filial de outra. Se continuar processando pedidos, pode haver confusão fiscal, estoque saindo errado, ou devoluções pra quem não está mais ativo.
- **Opções:** (A) Bloquear completamente: nenhum pedido da empresa inativa é processado (nem novos, nem os que estão na fila) → Seguro, mas completo. Todos os pedidos da empresa em andamento ficam congelados. Precisa desvincular manualmente.  ·  (B) Bloquear novos pedidos, mas deixar os que estão na fila terminarem normalmente → Pragmático: pedidos em andamento findam, mas ninguém cria novo pedido pra empresa inativa.  ·  (C) Rotear pedidos de empresa inativa pra uma empresa 'fallback' (substituta) → Continua processando, mas sob a conta de outra empresa. Precisa saber qual é a substituta.
- **Recomendação:** Bloquear novos pedidos da empresa inativa (rejeitar com erro claro). Pedidos já na fila terminam normalmente. Se tem pedidos em separação avançada, avisar admin antes de desativar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** empresa-lookup.ts:45-57, empresas/[id]/route.ts:36-44

### D036 — Operador imprimiu as etiquetas, depois cancelou a pendência — quem usa as etiquetas impressas?
- [ ] **vou fazer** · fluxo: Impressão de etiquetas para guardar mercadoria
- **Imagina assim:** Operador recebe lote com 5 unidades de um filtro (R$80). Imprime 5 etiquetas. Daí descobre que vem o mesmo filtro defeito de outro fornecedor. Clica em 'Cancelar Pendência' e marca 'Motivo: defeito'.
- **Hoje:** Etiquetas já saíram de graça. O sistema cancela a pendência (status = 'cancelada') e remove o produto do rastreamento. Mas as 5 folhas já estão impressas. Operador tem de jogá-las fora ou papéis viram lixo.
- **Por que importa:** Desperdício de papel, tinta e tempo. Pior: se alguém achar a etiqueta depois, pode tentar guardar um produto que não existe mais (pendência foi cancelada).
- **Opções:** (A) Avisar em tela ANTES de imprimir: 'Não será possível cancelar depois sem desperdiçar papel' → Operador pensa antes de imprimir. Simples, sem custos.  ·  (B) Permitir imprimir, mas bloquear cancelamento após impressão → Seguro, mas pode frustrar o operador que realmente precisa cancelar (ele terá de impedir a guarda de outro jeito).  ·  (C) Manter como está (permite tudo) → Flexível, mas com desperdício ocasional.
- **Recomendação:** Opção 1: avisar em tela que imprimir é ponto de não retorno. Custa quase nada, reduz erros sem bloquear ninguém.
- **➡️ MINHA ESCOLHA:** 
- **Código:** Fluxo de cancelamento em guarda

### D037 — Se um pedido for cancelado depois que já foi embalado e a etiqueta impressa, o sistema deveria permitir outra reimpressão ou bloquear?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta de separação
- **Imagina assim:** Pedido #5678 foi embalado, etiqueta impressa. Depois de 2 horas, vendedor cancela porque cliente pediu pra parar. Pedido marcado como 'cancelado'. Operador quer saber se consegue reimprimir a etiqueta.
- **Hoje:** Sistema permite reimprimir. A etiqueta é enviada pra impressora normalmente. Nenhum estoque é movimentado. Mas a etiqueta foi emitida pra um pedido que tá cancelado (desperdício de papel e possível nota fiscal pra nada).
- **Por que importa:** Se permitir reimpressão de um pedido cancelado, vai desperdiçar material. Se bloquear, operador pode querer reimprimir por uma última chance de recuperar (ex: cancelamento foi erro de digitação).
- **Opções:** (A) Bloquear reimpressão de pedidos cancelados → Nada de desperdício. Operador sabe que pedido cancelado não é recuperável nesse ponto.  ·  (B) Permitir mas avisar 'Este pedido está cancelado. Tem certeza que quer imprimir?' → Operador vê alerta. Se foi erro, consegue corrigir. Se foi mesmo cancelamento, evita 1 clique errado.  ·  (C) Permitir como hoje (sem nenhum aviso) → Máxima flexibilidade mas fácil desperdiçar.
- **Recomendação:** Opção 2. Avisar com alerta. Sistema deveria mostrar: 'ATENÇÃO: Este pedido foi CANCELADO. Reimpressão vai gastar material. Tem certeza?' Se operador clicar OK, aí imprime. Isso evita erros de clique mas mantém a porta aberta se foi cancelamento acidental.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:57-61

### D038 — O que fazer se um admin cancela um pedido enquanto o sistema está processando?
- [ ] **vou fazer** · fluxo: Processamento automático de pedidos aprovados
- **Imagina assim:** Uma tarefa automática está no meio do processamento de um pedido (já começou a lançar estoque, gerar nota). Nesse exato momento, um admin no sistema cancela o pedido.
- **Hoje:** A tarefa automática continua como se nada aconteceu. Pode gerar uma nota fiscal inteira, até enviar pra loja, mesmo que o pedido já está cancelado.
- **Por que importa:** Nota fiscal é gerada sem motivo. Estoque fica descontado mas produto nunca sai (ou sai e depois volta, confundindo tudo).
- **Opções:** (A) Pausar tarefa quando pedido é cancelado (verificar antes de cada passo) → Tarefa para, não gera nota, estoque volta. Limpo.  ·  (B) Deixar como está (manual cleanup) → Admin cancela e depois tem que desfazer a nota fiscal manualmente.
- **Recomendação:** Pausar a tarefa automaticamente. Se começou, verifica a cada passo se pedido ainda existe.
- **➡️ MINHA ESCOLHA:** 
- **Código:** execution-worker.ts:156-170

### D039 — Lançamentos retroativos criados hoje podem ficar sem reconciliar por dias — precisa limite de tempo pra expirar?
- [ ] **vou fazer** · fluxo: Lançamento de Estoque em Emergência (retroativo)
- **Imagina assim:** Operador lança um ajuste retroativo no dia 1º de junho. Por algum motivo (operador saiu de férias, mudou de ababa, esqueceu) não reconcilia. Em 5 de junho volta ao sistema e tenta reconciliar. Nesse meio-tempo, estoque foi movido, pedidos foram vendidos, tudo mudou.
- **Hoje:** O sistema NÃO limpa lançamentos antigos. Eles ficam listados indefinidamente (limite é 200 registros mais recentes). Ninguém recebe aviso de 'tem pendência de X dias'. Operador precisa lembrar (improvável).
- **Por que importa:** Ajustes retroativos são emergenciais. Se ficarem pendentes muito tempo, estoque fica com 'saldo do ar' (você não sabe se aquilo realmente chegou ou é só um lançamento esquecido). Auditoria fica confusa.
- **Opções:** (A) Lançamentos retroativos expiram em 3 dias se não reconciliados (sistema avisa no dia 2) → Força conclusão rápida. Saldo fica claro. Mas operador precisaria refazer se precisar de mais tempo.  ·  (B) Mostrar banner em vermelho no dashboard: 'X ajustes retroativos pendentes há Y dias' → Não força, mas alerta. Operador fica ciente e decide o que fazer.  ·  (C) Enviar notificação (email/app) todo dia se houver lançamento > 2 dias sem reconciliar → Ativo. Operador lembrado automaticamente. Pode ignorar se intencional.  ·  (D) Deixar como está (manual, sem limite) → Flexível. Mas requer disciplina de operador e monitoramento manual.
- **Recomendação:** Combine opção 2 + opção 3: mostre banner vermelho (visual) + envie notificação (ativa). Sem expiração forçada (muito rígido), mas com aviso agressivo pra movimentar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:559-591


## Tema: Integração com a loja (Tiny / marketplace) (39)

### D040 — Quando o operador procura por um código de produto (SKU), o sistema deve mostrar produtos que começam com esse código ou produtos que contenham esse código em qualquer lugar?
- [ ] **vou fazer** · fluxo: Acompanhamento de pedido — do que chega até sair do galpão
- **Imagina assim:** Operador busca pelo SKU 'ABC-123' e o sistema mostra 2 resultados: um produto chamado 'ABC-123' (correto) e outro chamado 'ABC-1234' (parecido, mas diferente).
- **Hoje:** O sistema procura por 'qualquer coisa que contenha ABC-123' — então encontra 'ABC-123' e 'ABC-1234' juntos. Funciona assim por padrão porque usa a busca de 'contém em qualquer lugar'.
- **Por que importa:** Se seu time procura por SKU errado sem querer, vai separar produto errado, embala errado, envia pro cliente errado. Erros de separação custam reembolso + reputação.
- **Opções:** (A) Busca exata: 'ABC-123' encontra APENAS 'ABC-123', não encontra 'ABC-1234' → Menos confusão, operador consegue encontrar o produto certo rapidinho. Mas se não sabe o SKU exato, não encontra nada.  ·  (B) Deixar como está: 'ABC-123' encontra 'ABC-123' e 'ABC-1234' juntos → Operador sempre vê mais opções, mas pode ficar confuso e escolher a errada.  ·  (C) Busca prefix (começa com): 'ABC-123' encontra 'ABC-123', 'ABC-1234', 'ABC-12345', mas não 'XABC-123' → Meio termo — reduz falsos positivos, mas ainda oferece variações lógicas.
- **Recomendação:** Recomendo opção 3 (prefix) — reduz confusão sem perder flexibilidade. A maioria dos SKUs tem uma lógica (ABC-123x são variações do mesmo produto).
- **➡️ MINHA ESCOLHA:** 
- **Código:** tracking/route.ts linhas 95-106 applyBuscaFilter com ILIKE %busca%

### D041 — Pedido chegou cancelado da loja (cliente cancelou lá), mas operador não viu e clicou cancelar aqui também. Contar duas vezes?
- [ ] **vou fazer** · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Cliente cancela pedido no Tiny. O aviso chega pro seu sistema e marca como cancelado. 5 minutos depois, operador local clica 'cancelar' sem perceber que já foi.
- **Hoje:** Sistema processa o segundo cancelamento como se fosse novo. Tenta estornar estoque de novo (que já foi), registra o evento 'cancelado' duas vezes. Auditoria mostra dois cancelamentos para o mesmo pedido.
- **Por que importa:** Relatório fica poluído com duplicação. Se você contar 'quantos pedidos foram cancelados hoje', fica errado. Mais importante: se há estoque envolvido, pode contar a liberação em duplicado.
- **Opções:** (A) Avisar operador que já foi cancelado e recusar o segundo clique → Previne o erro. Educativo pro operador.  ·  (B) Permitir o segundo cancelamento mas ser automático (não faz nada, só avisa 'já estava cancelado') → Flexível. Operador clica sem medo. Mas não deixa claro se 'já era'.
- **Recomendação:** Avisar: 'Este pedido já foi cancelado na loja em [horário]. Clique novamente pra confirmar que quer cancelar aqui também (será registrado como 'confirmação de cancelamento')'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts:43-55

### D042 — Pedido com itens de múltiplos fornecedores no mesmo carrinho: como lidar?
- [ ] **vou fazer** · fluxo: Iniciar a separação de pedidos
- **Imagina assim:** Chega um pedido manual (cross-dock) com 5 itens. 3 itens estão guardados no galpão A com fornecedor X, mas 2 itens estão no galpão B com fornecedor Y. É o mesmo pedido, mesmo cliente, para ser entregue junto.
- **Hoje:** O sistema só olha pra empresa de ORIGEM do pedido. Os itens do fornecedor Y não encontram localização no sistema (localização fica vazia). Operador vê 'SKU ABC, qty 2, prateleira: desconhecida'. Tira do checklist como 'divergência, sem localização'.
- **Por que importa:** Operador fica no suspense: ele não consegue encontrar o item na prateleira porque o sistema não sabe onde procurar. Pode perder tempo procurando ou deixar o item pra trás sem perceber que deveria ter sido separado.
- **Opções:** (A) Bloquear pedidos multi-fornecedor na entrada: cada pedido só aceita itens do mesmo fornecedor → Simplifica tudo. Operador nunca vê esse problema. Mas precisa separar o pedido em dois (dois ciclos de picking).  ·  (B) Permitir multi-fornecedor: sistema procura a localização certa pra cada item, independente de qual fornecedor é → Um pedido, um ciclo, mais rápido. Mas precisa de ajustes no consolidador de produtos pra respeitar empresa de CADA item, não só origem do pedido.  ·  (C) Avisar e deixar operador resolver: mostrar 'itens de duas localizações diferentes' e operador marca parcialmente → Máxima flexibilidade, mas operador fica carregando a decisão. Mais confusão, mais risco de erro.
- **Recomendação:** Permitir multi-fornecedor, mas corrigir o sistema pra achar a localização certa de cada item. Um pedido deve sair de uma vez, não em dois carrinhos.
- **➡️ MINHA ESCOLHA:** 
- **Código:** rpc 20260529 linha 24-27

### D043 — Quando entra um pedido com quantidade zero (ou negativa), o sistema deveria rejeitar logo na entrada ou ignorar silenciosamente o item?
- [ ] **vou fazer** · fluxo: Criar compra automática quando um pedido chega sem estoque
- **Imagina assim:** Loja envia um pedido com 2 itens: SKU 'CAMISETA' qty=5 e SKU 'CALÇA' qty=0 (pedido vazio ou erro da loja). Sistema recebe o aviso.
- **Hoje:** Sistema ignora itens com qty=0 durante a reserva. O item fica registrado no pedido com quantidade zero, mas não gera reserva, não bloqueia nada. Pedido avança normalmente.
- **Por que importa:** Você não sabe se foi erro da loja ou de propósito (devolução parcial?). Item fictício fica no banco de dados sem gerar ação — confunde o relatório.
- **Opções:** (A) Rejeitar pedido inteiro: 'erro de qty, refaça o pedido' → Força loja a corrigir antes de enviar. Pedido nunca entra com lixo. Mais rigoroso.  ·  (B) Aceitar pedido mas descartar itens com qty<=0 silenciosamente → Pedido entra, mas só os itens válidos (qty>0) são processados. Flexível, loja não precisa refazer. Menos puro.  ·  (C) Aceitar e alertar (criar exceção pro operador revisar) → Pedido entra, item fictício é marcado pra revisão. Operador decide manualmente. Máximo controle.
- **Recomendação:** Opção 1 é a mais limpa: valide na entrada e rejeite se qty<=0. Loja aprende e não envia lixo de novo. Leva 30 minutos pra adicionar validação.
- **➡️ MINHA ESCOLHA:** 
- **Código:** webhook-processor-wms.ts:549-551, pedidos/aprovar/route.ts:517-519

### D044 — Um produto que chega do pedido não está cadastrado no nosso WMS. O que fazer?
- [ ] **vou fazer** · fluxo: Reconciliação de pedidos quando entra estoque novo
- **Imagina assim:** Loja manda um pedido com 2 itens: SKU-A (você tem estoque) e SKU-X (desconhecido, não está na sua lista de produtos). Sistema tenta rotear esse pedido pra decisão (próprio WMS ou comprar).
- **Hoje:** Sistema ignora SKU-X (não consegue mapear). Ele processa só SKU-A (que você tem), marca esse item pra separação. SKU-X some do pedido — não entra em separação, não entra em compra, não entra em nada. Cliente recebeu só o A, não sabe onde está o X.
- **Por que importa:** Um produto inteiro desaparece do pedido. Cliente pagou por 2 itens, recebe 1. Vai reclamar. Você não sabe que X está órfão até o cliente ligar.
- **Opções:** (A) Ignorar SKU-X e enviar pedido com só SKU-A → Pedido incompleto, cliente reclama, você precisa chamar a loja depois pra saber por que X não veio. Desgaste.  ·  (B) Rejeitar o pedido inteiro se tiver um item desconhecido → Loja vai conferir o cadastro, corrigir o mapeamento de SKU-X, reenvia. Pedido entra certo da segunda vez. Mais correto, mas mais demora.  ·  (C) Aceitar SKU-A pra separação e marcar SKU-X como 'falta mapear' numa fila que o gerente vê → Pedido sai com A, você sabe que falta X. Gerente entra em contato com loja, pede a SKU correta de X, depois envia isso separado ou cancela. Mais transparente.
- **Recomendação:** Escolha a opção 3: Aceite SKU-A, marque X como falta mapear e coloque numa fila visual pro seu gerente. Assim você não perde vendas óbvias, mas tbm não deixa nada sumindo sem aviso.
- **➡️ MINHA ESCOLHA:** 
- **Código:** webhook-processor-wms.ts:386-402

### D045 — Dois pedidos iguais chegam da loja no mesmo instante (erro de duplicação). Sistema pede 2x?
- [ ] **vou fazer** · fluxo: Reconciliação de pedidos quando entra estoque novo
- **Imagina assim:** Marketplace tem um glitch e manda o mesmo pedido PED222 duas vezes em 2 segundos (ou sua API envia pro WMS duas vezes simultaneamente). Sistema recebe nos dois canais ao mesmo tempo.
- **Hoje:** Sistema aceita os dois. Resultado: pedido é criado 2x, estoque é apartado 2x (40 unidades apartadas quando deveria ser 20). O registro das movimentacoes de estoque tem 2 registros de apartado pro mesmo pedido. Quando chega a hora de processar, sistema pega ambas as reservas, cria saída para as 2 — estoque fica -20 (negativo).
- **Por que importa:** Estoque fica negativo ou radicalmente errado. Você acha que vendeu 20 quando na verdade contou 40. Seus números de disponível ficam absurdos. Próximo cliente não consegue comprar porque 'não tem estoque'.
- **Opções:** (A) Deduplicar antes: marketplace não manda 2x o mesmo pedido (arrumar no Tiny/marketplace) → Aviso chega 1x de verdade. Mas se der glitch novamente, o WMS ainda cai — é uma cura no Tiny, não aqui.  ·  (B) Deduplicar no WMS: se pedido PED222 já foi visto, ignora a 2ª tentativa → Qualquer glitch de duplicação é absorvido aqui. WMS sempre responde 'ok recebido' mas processa só 1x. Estoque fica correto.  ·  (C) Deixar como está (sem proteção contra duplicação) → Se glitch de duplicação em loja, seu estoque fica errado. Precisa de auditoria manual depois pra corrigir.
- **Recomendação:** Escolha a opção 2: WMS coloca um ID único em cada aviso (ID Tiny + tipo + estado da loja forma uma chave única). Se aviso com mesma chave chega 2x, ignora. Isso é dedup no lado do WMS — mais seguro, você não depende de Tiny arrumar o glitch.
- **➡️ MINHA ESCOLHA:** 
- **Código:** webhook-processor-wms.ts:437-536

### D046 — Quando o WMS tem MAIS estoque registrado que o Tiny, qual deve ser a verdade?
- [ ] **vou fazer** · fluxo: Relatório de Sincronização com Tiny (sistema antigo)
- **Imagina assim:** Exemplo: pneu PNEU-LING. No Tiny aparecem 50 unidades. Na sua prateleira de picking tem 30, na de overflow tem 25, total 55. O sistema detecta +5 a mais no WMS.
- **Hoje:** O sistema mostra na tela: WMS tem 55, Tiny tem 50, diferença +5 em verde. Mas nenhuma ação automática acontece.
- **Por que importa:** Essa diferença pode significar que uma compra chegou e você registrou, mas o Tiny ainda não sabe. Ou pode ser erro de contagem. Se você vender pelas regras do Tiny (50 unidades), pode prometer mais do que consegue guardar.
- **Opções:** (A) Confiança no WMS: aceitar automaticamente os 55 do WMS como certo e avisar o Tiny que são 55 → Você vende o certo, mas Tiny fica sincronizado. Qualquer erro de contagem no galpão passa direto pro Tiny.  ·  (B) Confiança no Tiny: aceitar os 50 do Tiny e corrigir o WMS pra 50 → Tiny fica como fonte da verdade, mas você perde as 5 unidades do registro. Se não eram erro, é prejuízo.  ·  (C) Parar e avisar: quando há diferença, bloqueia venda até operador revisar manualmente → Nenhuma venda errada, mas operador precisa estar sempre olhando alertas. Demora pra resolver.
- **Recomendação:** Comece com confiança no WMS (opção 1): seu sistema de prateleira é a verdade. Se há 55, você tem 55. Tiny se sincroniza com vocês, não o contrário. Ativa automático.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reconciliacao-tiny.ts:110-128

### D047 — Quando o WMS tem MENOS estoque que o Tiny, como você quer se comportar?
- [ ] **vou fazer** · fluxo: Relatório de Sincronização com Tiny (sistema antigo)
- **Imagina assim:** Exemplo: filtro FILTRO-AR. Tiny diz 100 unidades. Mas somando todas as prateleiras do seu galpão dá só 92. Diferença -8.
- **Hoje:** O sistema mostra na tela: WMS tem 92, Tiny tem 100, diferença -8 em vermelho. Anota em log que detectou 1 divergência, mas pausa aí.
- **Por que importa:** Essa diferença perigosa: significa que você vende 100 no Tiny, mas tem só 92. Quando o cliente pedir 95 unidades, você não consegue separar. Atura com cliente ou envia incompleto. Pior: se ninguém perceber, Tiny anuncia 100, você promete 100, mas entrega 92.
- **Opções:** (A) Bloqueia tudo: não vende mais no Tiny enquanto não achar as 8 unidades → Seguro, sem promessa errada. Mas você para de vender até resolver. Perde vendas se for só erro de contagem.  ·  (B) Aceita o WMS como verdade (92) e reduz no Tiny automaticamente → Tiny passa a dizer 92. Clientes só compram 92. Mas você perde as 8 unidades de receita se não eram erro.  ·  (C) Aviso ao operador: a tela mostra ALERTA VERMELHO, precisa investigar antes de aceitar → Você olha, conta novamente, e decide: era erro mesmo? Tinha item quebrado? Saiu uma venda não registrada? Aí você age.
- **Recomendação:** Use a opção 3: quando há -8 ou maior diferença, o sistema alerta em VERMELHO e bloqueia até você confirmar. Você conta novamente, descobre por que faltam as 8 (ou acha que estão só em outro lugar), e aí resolve.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reconciliacao-tiny.ts:116

### D048 — Se alguém separa um pedido ENQUANTO o sistema está comparando estoque, que número fica registrado?
- [ ] **vou fazer** · fluxo: Relatório de Sincronização com Tiny (sistema antigo)
- **Imagina assim:** Timeline: (1) Sistema começa a contar o WMS: 50 unidades de um produto. (2) Nesse meio-tempo, separador pega 5 unidades pra um pedido. (3) Sistema termina de contar o Tiny: 50. Resultado: WMS vê 45 agora, Tiny vê 50, mas o sistema registra como se fossem iguais (delta=0).
- **Hoje:** O sistema faz a comparação, mas se alguém mexeu no estoque entre o começo e o fim da leitura, o número fica errado. A comparação não vê o problema porque tudo é rápido demais.
- **Por que importa:** Você pode estar vendendo um número de estoque que ninguém realmente tem. Se WMS caiu de 50 pra 45 mas sistema registrou delta=0, Tiny não recebe atualização. Vende 50 mas tem 45.
- **Opções:** (A) Usar data/hora: comparação só funciona se ambos os lados forem lidos no MESMO segundo → Se não sincronizarem, marcação automática de diferença. Mais seguro, mais complexo.  ·  (B) Bloquear estoque durante comparação: ninguém separa enquanto sistema está comparando (2-3 segundos) → Números ficam estáveis, não há mudança no meio do caminho. Mas separador tem que esperar, pode ficar lento.  ·  (C) Aceitar que vai ter ruído: roda a comparação várias vezes por dia para pegar as diferenças depois → Permite movimentação livre, mas a sincronização atrasa. Se diferença aparecer amanhã, resolve amanhã.
- **Recomendação:** Use opção 3 por enquanto: rode a comparação a cada 4 horas (não cada minuto). Pequenas diferenças de timing vão aparecer na próxima rodada, e você resolve com o resto. Mais simples e prático.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reconciliacao-tiny.ts:1-16

### D049 — Quando tem diferença de estoque, como você quer que o sistema a corrija?
- [ ] **vou fazer** · fluxo: Relatório de Sincronização com Tiny (sistema antigo)
- **Imagina assim:** Sistema mostra na tela: SKU PNEU-LING, WMS=55, Tiny=50, Delta=+5. Você quer sincronizar pra 55. Hoje você tem que: (1) copiar o código do produto, (2) entrar em outro menu de ajuste, (3) marcar em qual direção corrigir, (4) escrever um motivo, (5) apertar confirmar.
- **Hoje:** A tela de divergências é só informação (você olha e lê). Se quer corrigir, sai dessa tela, entra em outro lugar do sistema, e faz ajuste manual. Dois passos desnecessários.
- **Por que importa:** Operador perde tempo: vê o problema, sai da tela, entra em outro menu, refaz o trabalho. É cansativo e gera chance de erro. Uma decisão que poderia levar 3 segundos leva 30.
- **Opções:** (A) Botão direto: na tela de divergências, coloca botão 'Sincronizar este WMS com Tiny' → Um clique e pronto. Operador vê problema, resolve em 3 segundos. Precisa validar qual direção (WMS→Tiny ou Tiny→WMS) antes.  ·  (B) Deixar como está: tudo manual mesmo → Operador treina, acostuma. Demora 30 segundos por item, mas é o que existe agora.  ·  (C) Sincronização automática: sistema detecta diferença e corrige sozinho sem operador ver → Rapídissimo, zero cliques. Mas se sistema estiver errado, corrige pro lado errado automaticamente. Risco.
- **Recomendação:** Use opção 1: coloca botão direto. Operador vê diferença +5, clica em 'Aceitar WMS (55)', confirma em 2 segundos e pronto. Sem sair da tela, sem reescrever motivo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/relatorios/reconciliacao-tiny/page.tsx:1-176

### D050 — Se você tiver mais produtos que o sistema consegue comparar de uma vez, que produtos ficam de fora?
- [ ] **vou fazer** · fluxo: Relatório de Sincronização com Tiny (sistema antigo)
- **Imagina assim:** Você tem 230 produtos cadastrados. O sistema está configurado pra comparar 100 de uma vez. A comparação roda a cada dia. Produtos 1-100 são comparados, mas produtos 101-230 nunca entram nessa rodada.
- **Hoje:** Sistema tira foto de 100 produtos a cada rodada. Se você tem 230, os 130 últimos não aparecem em nenhuma comparação de divergência.
- **Por que importa:** Pode haver divergência enorme (tipo -50 unidades) no produto 150, mas você nunca fica sabendo porque está fora do limite de 100. Divergência fica escondida.
- **Opções:** (A) Aumentar o limite: comparar 250 ou 300 de uma vez → Todos os produtos entram na ronda. Pode ficar mais lento a comparação (alguns segundos mais), mas nenhum escapa.  ·  (B) Múltiplas rodadas: primeira ronda compara 100, segunda ronda os próximos 100, etc → Todos são comparados, mas não no mesmo dia. Produto 150 entra na ronda 2, após 12h ou 24h.  ·  (C) Deixar em 100 mesmo → Mais rápido, mas 130 produtos nunca têm check.
- **Recomendação:** Use opção 2: roda de 2 em 2 horas, 100 produtos por rodada. Ao final do dia, todos foram comparados. Nenhum escapa, e cada rodada é rápida.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reconciliacao-tiny.ts:71-76

### D051 — Se a loja fica offline ou bloqueia a gente, quanto tempo o sistema tenta sozinho?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** O sistema tenta atualizar a loja, loja retorna 'acesso negado' ou está fora do ar.
- **Hoje:** Sistema tenta, loja nega. Erro é registrado como crítico. Sistema aguarda, depois tenta de novo (número de vezes?). Vai ficar tentando sozinho até ser feliz ou até alguém perceber e desligar a conexão manual.
- **Por que importa:** Se deixar tentando infinito, pode ocupar recurso ou ficar fazendo barulho nos logs. Se parar muito cedo, pedidos ficam presos. Precisa de estratégia.
- **Opções:** (A) Tentar 3 vezes com espera crescente (1min, 5min, 15min), depois avisar admin → Problema transitório é resolvido. Problema crônico o admin descobre rápido.  ·  (B) Tentar indefinidamente até sucesso → Pedidos nunca ficam presos, mas pode ocupar sistema se problema for crônico.  ·  (C) Tentar 1 vez, se falhar marca pedido como 'erro manual' — admin resolve depois → Simples mas pedidos ficam presos facilmente. Manual demais.
- **Recomendação:** Opção 1: 3 tentativas com espera crescente, depois alerta. Admin vê no painel 'Conexão com loja caiu'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/tiny-oauth.ts:149-165 (trata erro, loga como 'critical' mas não resgata job)

### D052 — Empresa tem 2 galpões em cidades diferentes — loja tem depósito de cada um. Conseguimos ligar os 2?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** NetAir: 1 galpão em Curitiba (depósito 100 na loja), 1 em São Paulo (depósito 200 na loja). Sistema hoje: 1 conexão = 1 depósito.
- **Hoje:** Cada empresa tem 1 conexão loja com 1 depósito associado. Se NetAir tiver 2 galpões, só consegue trabalhar com 1.
- **Por que importa:** Se precisa usar os 2 galpões, tem que escolher qual. Estoque do outro fica invisível pro sistema. Pode perder stock ou oferecer produtos que não estão lá.
- **Opções:** (A) Criar 2 conexões loja, uma por galpão → Cada galpão trabalha independente. Simples. Mas admin tem que manter 2 tokens/configs.  ·  (B) Conectar 1 empresa a N depósitos (quebrar relação 1:1) → Complexo. Sistema precisa saber qual galpão pra qual depósito. Novo campo na config.  ·  (C) Deixar como está — empresa escolhe qual galpão usa → Simples. Outro galpão fica de fora.
- **Recomendação:** Opção 1 por enquanto: se NetAir quer 2 galpões, admin cria 2 conexões. Mais trabalho mas desacopla galpões. Opção 2 é futura se virar padrão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** docs/database-schema.md:1144-1170 (1 row per empresa, not per galpao)

### D053 — Alguém roubou a senha da loja — precisa fazer login de novo. Tudo que estava em andamento perde o acesso?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Admin configura acesso via autorização. Sistema guarda chave de acesso. Depois, admin revoga chave na loja por segurança ou expira naturalmente.
- **Hoje:** Sistema tenta usar chave expirada. Loja nega. Sistema tenta renovar (usar chave de renovação). Se chave de renovação também expirou, retorna erro. Sistema loga como crítico.
- **Por que importa:** Sem saber se é 'temporário' (chave expirou, basta rodar login de novo) ou 'permanente' (senha mudou, acesso revogado), admin não sabe o que fazer. Pode deixar parado esperando acesso voltar.
- **Opções:** (A) Diferenciar: se erro é de credencial (chave ruim), mostrar 'Conexão expirada — faça login de novo'. Se é de loja offline, mostrar 'Loja offline — tenta depois'. → Admin sabe exatamente o que fazer. Pode ir no menu Configurações e clicar 'Autorizar de novo'.  ·  (B) Deixar como está — sempre erro crítico → Admin tenta de tudo. Confusão.  ·  (C) Tentar renovar automaticamente escondido → Problema resolve sozinho se chave renovar. Mas admin nunca avisa se problema é crônico.
- **Recomendação:** Opção 1: painel mostra diferente se é 'autorizar novamente' vs. 'loja offline'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/tiny-oauth.ts:149-165 (nao diferencia tipos de erro de refresh)

### D054 — Loja envia aviso de mudança mas com ID vazio ou errado — sistema cancela em silêncio?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Loja envia aviso de cancelamento mas o campo 'ID do pedido' vem vazio ou em branco.
- **Hoje:** Sistema checa se ID é válido. Se for vazio, rejeita (retorna erro 400). Aviso nunca é registrado em log. Silêncio.
- **Por que importa:** Admin nunca vê que loja tentou avisar algo. Pode ficar horas procurando por quê pedido não foi cancelado (porque aviso foi perdido).
- **Opções:** (A) Mesmo que rejeitar, registrar em log: 'Aviso da loja chegou com ID vazio — ignorado' → Admin tem rastreabilidade. Sabe que loja tentou algo mas dados vinham errados.  ·  (B) Deixar como está — silêncio → Ninguém sabe que tentou. Debugging fica difícil.  ·  (C) Alertar admin por e-mail cada vez que isso acontece → Admin avisa loja que algo tá errado no envio deles.
- **Recomendação:** Opção 1: sempre registrar tentativa (mesmo que rejeitada). Log fica completo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/webhook/tiny/route.ts:134-137 (não insere log se pedidoId vazio)

### D055 — Loja tenta avisar de pedido novo mas sistema ainda não foi configurado — o que acontece?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** NetAir acabou de instalar loja nova. Loja já começa a enviar avisos de pedido. Sistema recebe aviso mas conexão ainda não tá pronta (chave não foi gerada).
- **Hoje:** Sistema recebe aviso assincronamente (não espera resposta). Processa em segundo plano. Tenta buscar chave — não acha. Log de erro. Aviso é perdido ou fica marcado como erro.
- **Por que importa:** Primeiros pedidos podem ser perdidos. Cliente paga mas pedido não entra no sistema pra processar.
- **Opções:** (A) Gravar aviso como pendente se chave não estiver pronta. Tentar de novo a cada 5 minutos. → Quando admin habilitar a conexão, sistema processa avisos antigos também.  ·  (B) Deixar como está — pedido é perdido, admin precisa avisar cliente → Simples mas acarreta suporte manual.  ·  (C) Avisar à loja: 'Tá offline, manda de novo depois' → Loja retem aviso e envia depois. Mas loja pode não fazer isso.
- **Recomendação:** Opção 1: implementar fila de retry. Aviso fica pendente até conexão estar pronta.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/webhook/tiny/route.ts:375-396 (fire-and-forget, erro é logged mas 200 já foi enviado)

### D056 — Operador cancela pedido via sistema (não é aviso da loja) — estoque volta na loja também?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Pedido de 100 unidades foi separado e estoque foi atualizado na loja. Operador depois clica 'Cancelar' no painel interno.
- **Hoje:** Sistema libera as 100 peças internamente. Mas não confirmei se avisa a loja pra devolver.
- **Por que importa:** Se a loja não recebe aviso, acha que aquelas 100 peças foram entregues. Faz reposição errada ou oferece produto indisponível.
- **Opções:** (A) Cancelamento manual = cancela só internamente. Admin cancela manual na loja se precisar. → Simples. Mais manual mas control total.  ·  (B) Cancelamento manual = avisa a loja automaticamente (como aviso faz) → Sincronizado. Uma ação = dois sistemas atualizados.  ·  (C) Não deixar cancelar manualmente se estoque já foi lançado na loja → Força admin a desfazer na loja primeiro. Mais seguro mas engessado.
- **Recomendação:** Opção 2: manual cancela como aviso. Mesmo comportamento em qualquer origem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/webhook/tiny/route.ts:191-245 (webhook faz estorno mas rota manual?)

### D057 — Admin por erro salva um galpão de OUTRA empresa — sistema usa mesmo assim?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Admin configura NetAir (empresa A). Por engano, escolhe depósito 42 que pertence a Concorrente Corp (empresa B) na loja.
- **Hoje:** Sistema salva config. Quando processa pedido, manda pra loja: 'Guardar em depósito 42'. Loja valida: 'Depósito 42 é de empresa B, empresa A não tem permissão'. Retorna erro 403.
- **Por que importa:** Pedido fica preso até alguém perceber. Pode processar de verdade em lugar errado se validação da loja falhar.
- **Opções:** (A) Ao carregar depósitos, sistema valida: 'Esse depósito pertence a essa empresa?' → A tela mostra só opções corretas. Impossível escolher a errada.  ·  (B) A tela lista tudo, o sistema tenta, loja rejeita → Admin só descobre depois.  ·  (C) Sem validação, deixa acontecer → Mesma coisa. Erro descoberto durante processamento.
- **Recomendação:** Opção 1: validar na carga de depósitos. A tela mostra só o que é permissível.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/configuracoes/conexoes/page.tsx:693-717 (loadDepositos sem validação de proprietário)

### D058 — Para segurança, a chave de autorização guarda ID da conexão na comunicação — é problema?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Sistema autoriza na loja. Comunicação inclui identificador da conexão (UUID). Terceiro intercepta a comunicação.
- **Hoje:** Identificação da autorização = UUID-da-conexao:aleatório. Terceiro vê UUID e deduz qual conexão tá sendo autorizada.
- **Por que importa:** Informação mínima (não é crítica) mas pode ajudar ataque. Se alguém sabe qual conexão você tá autorizando, pode tentar interferir.
- **Opções:** (A) Identificação = aleatório puro (sem UUID). Sistema registra qual conexão = identificação no banco e busca inverso. → Fora a relação, ninguém sabe qual UUID tá sendo autorizado.  ·  (B) Deixar como está — risco baixo → Simples. Mas pequena exposição.  ·  (C) Usar padrão moderno de autorização (como PKCE) + identificação aleatória → Mais seguro. Padrão moderno.
- **Recomendação:** Opção 1 ou 3. Opção 1 é mínima, opção 3 é overkill. Comece com opção 1.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/oauth/route.ts:42 (state = connectionId:uuid format)

### D059 — Banco de logs de aviso cresce 500/dia — nunca limpa. Eventualmente fica lento?
- [ ] **vou fazer** · fluxo: Conexão com a loja (Tiny ERP) - autorização e avisos de pedidos
- **Imagina assim:** Cada aviso que loja envia é registrado em tabela. 500 avisos/dia × 365 dias = 182.5 mil registros/ano. Sem limpeza.
- **Hoje:** Tabela cresce indefinidamente. Hoje é rápido porque tem mil registros. Em 5 anos, terá 900 mil.
- **Por que importa:** Tabela grande = consultas lentas = painel demora pra carregar relatório de avisos.
- **Opções:** (A) Arquivar: deletar automático de registros com mais de 90 dias → Tabela capa em ~90k registros. Consultas rápidas sempre.  ·  (B) Partição por data: novo arquivo de dados a cada mês → Mesma coisa, mas mais eficiente no storage.  ·  (C) Deixar crescer → Funciona agora. Em 5 anos, relatórios ficam lentos.
- **Recomendação:** Opção 1: implementar rotina automatica que deleta registros > 90 dias. Simples e eficaz.
- **➡️ MINHA ESCOLHA:** 
- **Código:** docs/database-schema.md (webhook logs não mencionam retention)

### D060 — Quando a renovação da autorização falha (timeout, internet cai), o sistema deve tentar de novo ou desistir?
- [ ] **vou fazer** · fluxo: Integração com MercadoLivre (Autenticação + Sincronização de Anúncios)
- **Imagina assim:** Sistema tenta renovar a chave de acesso com o ML. A requisição demora demais ou cai. Sistema registra o erro e para de tentar.
- **Hoje:** O sistema registra o erro, zera a marcação de 'tentando renovar agora'. Próxima requisição vê que está zerado e tenta renovar de novo. Funciona, mas pode gerar múltiplas tentativas seguidas em falhas persistentes.
- **Por que importa:** Se falha por instabilidade temporária (internet fraca, pico de carga), tentar novamente resolve sozinho. Se falha porque a chave realmente expirou, tentar 3x custa mais que avisar ao operador. Você precisa de visibilidade: quando desistir, quem avisa?
- **Opções:** (A) Tentar de novo imediatamente (sem limite), até conseguir → Bom para falhas transitórias. Ruim se a chave realmente expirou: vai pedir 100x e consumir recursos.  ·  (B) Tentar até 3x com espera (5s, 10s, 30s), depois desistir e alertar operador → Recupera de internet fraca. Se persistir, avisa quem precisa reconectar. Controle total.  ·  (C) Desistir na primeira falha e alertar operador imediatamente → Você sabe rápido que há problema. Menos espera. Mas perde oportunidade de recuperar de falhas transitórias.
- **Recomendação:** Opção 2: até 3 tentativas com espera crescente, depois alerta. Você ganha resiliência sem desperdício de recursos, e fica informado de problemas reais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ml-oauth.ts:260-315, 249-258

### D061 — Quando procura um artigo no MercadoLivre (ex: 'parafuso'), mas tem mais de 1000 resultados, o que fazer com o que não couber na busca?
- [ ] **vou fazer** · fluxo: Integração com MercadoLivre (Autenticação + Sincronização de Anúncios)
- **Imagina assim:** Você vende parafusos e quer sincronizar os anúncios. Sua loja tem 3000 parafusos cadastrados. MercadoLivre permite trazer 1000 itens por busca. O sistema traz só o 1º milhar. Os outros 2000 ficam invisíveis.
- **Hoje:** O sistema faz duas buscas em paralelo, cada uma traz até 1000 itens. Se tem 3000 parafusos, 2000 nunca são baixados. Operador não vê aqueles anúncios em nenhum lugar.
- **Por que importa:** Artigos ficarão sem sincronizar. Você pode gastar tempo procurando por quê um parafuso não aparece, quando na verdade ultrapassou o limite de busca. Perde visibilidade sobre inventory.
- **Opções:** (A) Buscar por categorias ou filtros menores, em vez de tudo de uma vez → Traz todos os 3000. Precisa refatorar lógica de busca. Mais lento.  ·  (B) Avisar operador que não foram trazidos todos, e pedir pra refinar a busca (ex: 'parafuso M6') → Você controla. Manual, mas funciona. Operador sabe que há limite.  ·  (C) Deixar como está (1000 máx), documentar o limite pra operador → Sem mudança. Você fica ciente da limitação e adapta busca se precisar.
- **Recomendação:** Opção 2: avisar com claro mensagem de limite ('Mostrando 1000 de 2500, refine a busca'). Simples de implementar e deixa você no controle.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ml-api.ts:138-180, 205

### D062 — Quando um operador conecta uma conta MercadoLivre, você quer associá-la a uma empresa específica? Ou pode ficar desassociada por enquanto?
- [ ] **vou fazer** · fluxo: Integração com MercadoLivre (Autenticação + Sincronização de Anúncios)
- **Imagina assim:** Operador conecta conta ML, mas não escolhe qual empresa é. Depois, quer vincular aquela conexão a uma empresa (ex: 'Essa conta é da Filial SP'). Sistema permite editar depois.
- **Hoje:** Quando conecta, empresa fica em branco. Operador pode clicar em editar e escolher a empresa depois. Sistema salva sem problema. Relatórios usam aquele vínculo pra filtrar dados.
- **Por que importa:** Organização: saber qual conta ML serve qual loja/empresa. Relatórios corretos. Se sua estrutura tem múltiplas filiais ou marcas, você precisa dessa informação.
- **Opções:** (A) Obrigar escolher empresa na hora de conectar → Nada fica solto. Sempre completo. Operador pode se recusar a conectar se não souber a empresa.  ·  (B) Permitir conectar sem empresa, e editar depois (como é hoje) → Menos fricção. Operador conecta rápido. Mas pode esquecer de vincular, deixando dados soltos.  ·  (C) Sugerir empresa (pré-preenchida com a mais comum), mas permitir mudar → Bom compromisso. Maioria não mexe (rápido). Quem precisa mudar consegue.
- **Recomendação:** Opção 3: sugerir a empresa padrão. Reduz fricção, mantém dados organizados, e deixa flexibilidade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** connections/route.ts:53-78, 18

### D063 — Cache dos anúncios dura 5 minutos. Depois expira e busca do zero. Mas e se anúncio foi pausado no MercadoLivre ANTES de expirar?
- [ ] **vou fazer** · fluxo: Integração com MercadoLivre (Autenticação + Sincronização de Anúncios)
- **Imagina assim:** Você pausa um anúncio no MercadoLivre (ex: sem estoque). Cache ainda tem 4 minutos. Operador clica 'Ver anúncios'. Vê aquele anúncio marcado como 'ativo', quando na verdade já foi pausado.
- **Hoje:** O sistema guarda uma cópia dos anúncios a cada 5 minutos. Se você pausar no meio (ex: no minuto 2), operador continua vendo 'ativo' até o cache expirar (no minuto 5). Depois que expira, busca de novo e vê correto (pausado).
- **Por que importa:** Desinformação temporária. Você toma decisão (ex: 'vou vender mais') baseada em dado obsoleto. Em negócio rápido, 5 minutos é tempo demais.
- **Opções:** (A) Reduzir tempo de cache pra 1 minuto → Mais atualizado. Mas mais carga no ML (100x mais requisições). ML pode throttle sua conta.  ·  (B) Deixar botão 'Atualizar agora' visível, pra buscar antes do cache expirar → Você controla quando quer dados frescos. Operador responsável. Cache continua pra casos comuns.  ·  (C) Quando entra um pedido novo no MercadoLivre, o sistema avisa e atualiza anúncios na hora → Sempre em tempo real. Mas precisa ML enviar esse aviso. Mais complexo.
- **Recomendação:** Opção 2: botão 'Atualizar agora' bem visível. Você controla atualização quando precisa, cache economiza requisições no dia a dia.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ml-anuncios.ts:50-80, 82-118, 162-167

### D064 — Quando testa se a conta ML está conectada, o teste passa. Mas a autorização expira poucos dias depois sem aviso. Quando você quer saber se está realmente expirada?
- [ ] **vou fazer** · fluxo: Integração com MercadoLivre (Autenticação + Sincronização de Anúncios)
- **Imagina assim:** Você clica 'Testar conexão ML'. Sistema diz 'OK, tudo certo'. Uma semana depois, quer sincronizar anúncios. Aí falha porque a chave expirou. Ninguém avisou.
- **Hoje:** Teste verifica se chave é válida AGORA. Se sim, retorna OK. Mas chave de acesso dura 6 horas, e chave de renovação dura 6 meses sem uso. Se ninguém mexe nos anúncios por 6 meses, chave de renovação vira pó. Próxima vez que tenta sincronizar, falha. Sistema não avisa antecipadamente.
- **Por que importa:** Integração desaparece silenciosamente. Você descobre quando pior: anúncios param de sincronizar, pedidos param de entrar. Suporte reativo, não proativo.
- **Opções:** (A) Monitorar regularmente (ex: a cada 5 dias) e avisar se chave está perto de vencer → Você tem dias úteis pra reconectar ANTES de quebrar. Proativo. Precisa de tarefa automática.  ·  (B) Avisar só quando teste falhar (como é hoje, mas com notificação clara) → Reativo. Você descobre quando já é tarde. Simples de fazer.  ·  (C) Conectar com 'remember me' (duração indefinida), se ML permitir → Sem expiração. Ideal. Mas depende de ML suportar (verificar documentação).
- **Recomendação:** Opção 1: monitorar a cada 5 dias e avisar antecipadamente. Vai economizar horas de debug e downtime. Você fica no controle e avisa operador com 1-2 dias de antecedência pra reconectar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ml-oauth.ts:260-315, 209-212

### D065 — Se você tem 2 empresas que compartilham o mesmo produto (mesmo código), elas veem o custo uma da outra?
- [ ] **vou fazer** · fluxo: Relatório de Custo Médio dos Produtos
- **Imagina assim:** Sua empresa (Netair) e uma empresa parceira (Distribuidor) vendem o mesmo produto (GTIN 123). Netair recebe entrada a 5 reais (10 un). Distribuidor recebe entrada a 12 reais (3 un). Quem vê custo médio de 6.92 (que é (10×5+3×12)/13)?
- **Hoje:** O sistema NÃO separa por empresa. Quando você pede 'custo do produto 123', retorna todas as entradas de todas as empresas. Seu custo médio fica calculado com mercadoria de parceiros. Você vê entrada de Netair (10@5) + entrada do Distribuidor (3@12) = custo global 6.92.
- **Por que importa:** Se cada empresa tem seu próprio estoque e sua própria margem, misturar custos quebra a contabilidade de cada uma. Seu custo fica contaminado com custo de quem mais trabalha com o produto. Relatórios financeiros de cada empresa ficam incorretos.
- **Opções:** (A) Custo é global — compartilhado entre empresas (um produto, um custo) → Faz sentido se vocês compartilham um mesmo galpão (mercadoria é fungível). Mais simples, menos duplicação. Cada empresa vê o custo real de quem está mexendo com aquele produto.  ·  (B) Custo é por empresa — cada uma tem seu próprio custo médio → Faz sentido se cada empresa tem seu próprio estoque e precisa de contabilidade separada. Precisa adicionar 'empresa' como dimensão no cálculo de custo. Mais complexo.  ·  (C) Custo é por empresa E por galpão — máxima granularidade → Faz sentido se compartilham galpão mas querem saber custo real de quem trabalha com cada prateleira. Mais preciso, mas muito complexo.
- **Recomendação:** Defina com o dono: seu modelo é 'estoque compartilhado global' (opção 1) ou 'cada empresa sua contabilidade' (opção 2)? Isso afeta todas as duas decisões anteriores também. Se é global, custo misto é OK. Se é por empresa, precisa filtrar relatórios e custos por empresa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** historico-custo/route.ts:26-56

### D066 — Quando você tem mais estoque que Tiny (WMS mostra 15, Tiny mostra 10 — +5 peças), é realmente um problema?
- [ ] **vou fazer** · fluxo: Conferência de estoque entre WMS e Tiny
- **Imagina assim:** Um produto seu tem 15 unidades no seu sistema, 10 em Tiny. Diferença de +5 a seu favor.
- **Hoje:** Sistema marca na lista com fundo verde (você tem mais). Deixa à sua escolha o que fazer.
- **Por que importa:** Pode ser normal — às vezes você recebe, guarda, mas Tiny sincroniza lento (demora até 1 hora). Ou pode ser seu comprador que adicionou estoque em Tiny manualmente sem avisar. Decisão depende da causa: se é só atraso, aguarda. Se é erro, corrige.
- **Opções:** (A) Esperança inteligente: aguardar 1 hora — Tiny se sincroniza automaticamente (geralmente) → Se foi atraso normal, +5 vira 0 sozinho. Se não virar, aí sim tem algo errado.  ·  (B) Aceitar como está — você tem 15, Tiny mostra 10, vende só 10 em Tiny pra ser seguro → Seguro, mas você deixa 5 peças paradas, não anuncia, não vende.  ·  (C) Corrigir Tiny — aumentar de 10 pra 15 → Rápido, mas se houver entrada pendente em Tiny, você conta duas vezes.
- **Recomendação:** Aguarde 1h se foi entrada recente. Se tiver mais de 1h de idade e não mudou, investigue se seu comprador fez ajuste manual em Tiny — converse com ele antes de mexer.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reconciliacao-tiny.ts:110-128; tiny-api.ts:264-269; page.tsx:64

### D067 — Se Tiny fica fora do ar (muitos acessos, fica lento), o relatório falha — avisar operador?
- [ ] **vou fazer** · fluxo: Conferência de estoque entre WMS e Tiny
- **Imagina assim:** Você roda relatório de sincronização. Tiny está recebendo muitas requisições, responde com 'aguarde um pouco' (erro 429). Sistema tenta 3 vezes, depois desiste.
- **Hoje:** Sistema registra internamente 'falhou verificar 3 produtos em Tiny'. Você vê um número no painel: 'X falhas Tiny'. Mas não sabe qual produto falhou.
- **Por que importa:** Se não sabe qual produto, não sabe se pode confiar no relatório. Pode estar deixando de vender de uma SKU que Tiny tinha mas o relatório não viu.
- **Opções:** (A) Deixar como está — avisa que teve falha, mas não diz qual produto → Rápido codificar, operador fica na dúvida.  ·  (B) Listar os produtos que falharam — 'Não conseguimos sincronizar: Parafuso M4 (#103), Porca M4 (#104), Arruela (#105)' → Operador sabe exatamente quais revisar. Mais informação = decisão melhor.  ·  (C) Avisar: 'Sincronização incompleta em 3 produtos. Aguarde 5 minutos e rode novamente' → Operador entende que pode tentar depois. Menos ansiedade.
- **Recomendação:** Faça as três coisas: liste produtos que falharam, avise que aguarde 5 minutos, e deixe botão de 'Tentar novamente' na mão do operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** tiny-api.ts:68-77; reconciliacao-tiny.ts:130-137

### D068 — Se já corrigi uma divergência ontem, por que aparece de novo hoje?
- [ ] **vou fazer** · fluxo: Conferência de estoque entre WMS e Tiny
- **Imagina assim:** Ontem: relatório mostrou Parafuso M4 com +5 peças a mais em você. Você corrigiu em Tiny. Hoje roda relatório novamente — +5 aparece de novo.
- **Hoje:** Cada vez que roda relatório, ele tira uma foto do saldo agora em você + saldo agora em Tiny. Compara. Se você não sincronizou nos dois lados, divergência volta.
- **Por que importa:** Você pode ficar achando que é um loop infinito, que o sistema não presta. Na verdade, é porque só metade foi corrigida.
- **Opções:** (A) Corrigir Tiny e deixar seu sistema em paz — espera sincronização automática (até 1h depois) → Se sincroniza, acaba. Se não sincroniza, divergência volta amanhã.  ·  (B) Corrigir em ambos: Tiny + seu sistema (ajuste manual) → Garante que não volta. Trabalho dobro, mas seguro.  ·  (C) Ignorar e deixar para sincronização automática fazer seu trabalho → Pode levar horas. Risco de vender errado no meio do tempo.
- **Recomendação:** Entenda: reconciliação é diagnóstico, não remédio. Você tem que corrigir a raiz. Se foi seu lado (estoque entrou errado), corrija você. Se foi Tiny, corrija lá. Depois sincronização une tudo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reconciliacao-tiny.ts:90-98

### D069 — Se eu editar manualmente um produto e depois sincronizar com o fornecedor, qual dos dois valores fica (manual ou fornecedor)?
- [ ] **vou fazer** · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Admin editou a descrição de um produto de 'Vela Branca' pra 'Vela Branca Premium'. Dias depois, clica sincronizar e o fornecedor tem 'Vela Branca LED'.
- **Hoje:** Sincronização sobrescreve. Fica 'Vela Branca LED' (fornecedor vence). Admin não fica sabendo que suas mudanças foram apagadas.
- **Por que importa:** Confusão sobre qual é a 'verdade' dos dados. Se o operador espera que sua edição manual é importante, fica chocado quando desaparece. Ou se precisa sincronizar e depois quer manter uma edição local (ex: adicionar informação de custo local), a sincronização destroi tudo.
- **Opções:** (A) Documentar bem: 'Sincronizar SEMPRE sobrescreve edições manuais — não use os dois ao mesmo tempo' → Admin entende as regras. Se editar, sabe que não pode sincronizar depois (ou a edição some).  ·  (B) Avisar no UI antes de sincronizar: 'Vai sobrescrever sua edição de X dias atrás. Confirma?' → Admin tem chance de salvar a edição em outro lugar antes de perder. Mais controle.  ·  (C) Modo 'fusão': alguns campos sincronização sobrescreve (código, NCM, GTIN), outros manual vence (descrição, anotações) → Melhor dos dois mundos. Complexo de manter, mas mais flexível.  ·  (D) Deixar como tá (sem documentação ou aviso) → Admin descobre do jeito duro: sua edição desaparece de repente.
- **Recomendação:** Opção 1 + 2: boa documentação + aviso na hora é o mínimo. Se quiser sofisticação, estude a opção 3 depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 4 em decidir

### D070 — Quando sincronização com o fornecedor falha no meio do caminho (conexão cai, fornecedor tá offline), o que fica salvo?
- [ ] **vou fazer** · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Admin clica sincronizar. Descrição do produto traz OK. Mas quando tenta buscar fornecedores, a conexão cai.
- **Hoje:** Sincronização é parcial (melhor esforço): produto atualiza, fornecedores pulam com aviso interno. Fica parcialmente sincronizado.
- **Por que importa:** Você não sabe se sincronizou tudo ou só parcialmente. Se aparecer um problema depois (fornecedor errado, desatualizado), você acha que sincronizou 100% mas na verdade pulou partes.
- **Opções:** (A) Documentar: 'Sincronização é parcial — se falhar no meio, o que conseguiu fica salvo. Revise depois' → Admin entende que pode ser parcial. Se clicar de novo, preenche o resto.  ·  (B) Retornar {ok:true, warnings: ['1 fornecedor falhou, verifique depois']} pra UI mostrar aviso → Admin sabe na hora que algo falhou parcialmente. Pode clicar de novo ou investigar.  ·  (C) Tudo-ou-nada: ou sincroniza tudo ou não sincroniza nada. Se falhar, volta atrás. → Consistência garantida. Ou funciona 100% ou não funciona. Sem meia verdade.  ·  (D) Deixar silent (como é hoje) → Admin acha que sincronizou. Surpresa desagradável depois quando descobre que faltou.
- **Recomendação:** Opção 2 + 3 (nessa ordem): comece documentando bem + alertando na tela, depois estude tudo-ou-nada se vir muitos problemas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 6 em decidir

### D071 — Deixo salvar a chave do Tiny sem ter escolhido o galpão ainda?
- [ ] **vou fazer** · fluxo: Autenticação com Tiny, Mercado Livre e Impressoras
- **Imagina assim:** Um gerente autoriza o acesso ao Tiny (chaves são salvas no banco), mas não escolhe o galpão de onde saem os itens. A chave fica salva, galpão = vazio.
- **Hoje:** As chaves são salvas no banco com galpão em branco. Quando chega um pedido do Tiny, o sistema tenta rotear os itens, mas não sabe para qual galpão mandá-los. O roteamento falha ou usa um padrão invisível (arriscado).
- **Por que importa:** Se galpão não está definido, itens podem ir para o lugar errado, ou o sistema trava tentando processar o pedido. Cliente fica sem entrega, ou estoque some.
- **Opções:** (A) Permitir salvar sem galpão, e depois o gerente volta em configurações para escolher → Mais flexível, mas deixa uma janela de tempo em que os pedidos chegam e não sabem pra onde ir. Risco de perda de pedido.  ·  (B) Obrigar escolher o galpão antes de salvar a chave (ou logo após, em um passo 2 mandatório) → Galpão sempre preenchido. Nenhum pedido fica órfão. Mais seguro, mas exige um passo a mais no primeiro setup.
- **Recomendação:** Tornar obrigatório escolher o galpão antes de finalizar. É um setup único, vale a pena ser cuidadoso.
- **➡️ MINHA ESCOLHA:** 
- **Código:** Não confirmado em webhook-processor, presumido

### D072 — E se a chave expirar entre o momento que eu a pego do banco e o momento que eu a uso?
- [ ] **vou fazer** · fluxo: Autenticação com Tiny, Mercado Livre e Impressoras
- **Imagina assim:** O sistema pega a chave do banco (ainda válida). Passa tempo (leitura de disco, processamento, I/O longo). Quando finalmente tenta usar a chave, ela já expirou. A loja rejeita com um '401 - Acesso negado'.
- **Hoje:** Para Tiny: o sistema tenta usar a chave expirada e recebe erro. Fim — não tenta renovar. Para MercadoLivre: o sistema detecta o erro '401', automaticamente pede uma chave nova (força renovação imediata, ignorando os 5 minutos de buffer), tenta de novo, e agora funciona.
- **Por que importa:** Tiny fica com falhas que MercadoLivre não tem. Pedidos travam. Admin precisa fazer refresh manual ou reiniciar o sistema.
- **Opções:** (A) Deixar Tiny como está (se pegar erro 401, falha e fim) → Comportamento inconsistente: ML é automático, Tiny é manual. Mais falhas visíveis.  ·  (B) Ensinar Tiny a reagir como ML: quando recebe erro 401, renova a chave automaticamente e tenta de novo → Tiny fica resiliente, igual ML. Falhas raras, recuperação automática.
- **Recomendação:** Alinhar o comportamento. Copie a lógica de auto-tentativa do ML para o Tiny.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/ml-oauth.ts:379-429 e src/lib/ml-api.ts:80-112

### D073 — Quando um gerente muda a chave de integração, o sistema deve usar a chave nova imediatamente ou pode esperar até 5 minutos?
- [ ] **vou fazer** · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Gerente acessa configurações, vê que a chave de integração com PrintNode expirou, cola uma chave nova, clica 'Salvar'. Exatamente no mesmo momento, um operador em outro galpão clica para reimprimir uma etiqueta.
- **Hoje:** O sistema guarda a chave antiga em memória por até 5 minutos (cache). Se o operador clica reimprimir neste instante, usa a chave ANTIGA, não a nova. Se a chave antiga não funciona mais (foi cancelada), a impressão falha.
- **Por que importa:** Operador fica frustrado tentando reimprimir e falha. Gerente acha que corrigiu ao salvar, mas demora até 5 minutos para funcionar. Causa confusão e demanda de suporte.
- **Opções:** (A) O sistema esquece a chave antiga assim que o gerente salva a nova → Operador usa a chave nova na próxima impressão, sem demora. Tudo flui naturalmente.  ·  (B) O sistema continua usando a chave antiga até o cache expirar (em até 5 minutos) → Operador experimenta 'falhas aleatórias' de impressão. Gerente fica confuso porque acha que já corrigiu.
- **Recomendação:** Escolha a primeira. O sistema deve descartar o cache NA HORA quando a chave é alterada. Isso é seguro e elimina frustração.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/printnode.ts:281-282

### D074 — Um gerente deleta uma conta de impressora enquanto um operador está imprimindo uma etiqueta. O sistema deve bloquear ou permitir?
- [ ] **vou fazer** · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Gerente A está na tela de configuração deletando a conta PrintNode. Neste exato instante, Operador B em outro galpão clica 'Reimprimir etiqueta' de um pedido — uma ação que precisa daquela conta de impressora.
- **Hoje:** O sistema permite que o gerente delete a conta SEM bloquear. O operador, que está tentando imprimir neste momento, pode receber a chave velha (e funcionar) OU pode ver que a conta desapareceu (e falhar). Depende de qual ação executou primeiro — é sorte.
- **Por que importa:** É uma corrida entre deletar e usar. O operador pode levar susto: 'Posso ter perdido acesso à impressora no meio da ação?' Gerente não sabe se pode deletar sem quebrar operações em andamento.
- **Opções:** (A) Permitir que o gerente delete a conta a qualquer momento (comportamento de hoje) → Flexível, mas há risco de corrida. Operador pode falhar sem avisar por quê.  ·  (B) Bloquear a deleção se a conta está em uso agora → Sistema diz 'Não pode deletar agora — 2 galpões estão usando. Cancele antes.' Mais seguro, mas gerente precisa esperar.  ·  (C) Permitir deletar, mas exigir que gerente veja a lista de prateleiras afetadas primeiro → Gerente sabe o risco e pode avisar os responsáveis. Operador sabe que pode falhar porque gerente deletou a conta.
- **Recomendação:** Escolha a terceira opção. Permitir deletar, mas mostrar o impacto (quais prateleiras ficarão sem impressora). Gerente toma decisão informada.
- **➡️ MINHA ESCOLHA:** 
- **Código:** supabase/migrations/20260519_printnode_multi_contas.sql:40-42

### D075 — Quando a chave de integração com PrintNode é inválida (expirada, cancelada, ou digitada errado), que informação deve aparecer para o gerente quando imprime falha?
- [ ] **vou fazer** · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Gerente salvou uma chave PrintNode errada (digitou sem querer 2 números errados no meio). Operador tenta imprimir uma etiqueta. A impressão falha com erro 'Acesso negado' do PrintNode (erro 401).
- **Hoje:** O sistema loga: 'PrintNode 401: Não autorizado'. Mas o gerente vê apenas 'Falha ao imprimir' no sistema. Não fica claro se é problema de chave, impressora quebrada, ou conexão de internet.
- **Por que importa:** Gerente precisa saber QUAL conta de impressora falhou e POR QUÊ. Mensagem vaga leva a telefonema: 'Por que não tá imprimindo?' — sem contexto, fica tudo mais lento para resolver.
- **Opções:** (A) Mostrar mensagem clara: 'Conta PrintNode [Brasil Zona 1] retornou erro de acesso (401) — verifique a chave' → Gerente sabe exatamente qual conta falhou e por quê. Vai direto revisar aquela chave.  ·  (B) Mostrar mensagem genérica 'Falha ao imprimir — contate suporte' → Gerente fica no escuro. Demanda vai para suporte porque gerente não consegue resolver sozinho.
- **Recomendação:** Escolha a primeira opção. Mostre o nome da conta e o erro específico (401 = acesso negado). Gerente resolve sozinho.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/printnode.ts:149-190, src/lib/etiqueta-service.ts:126-128

### D076 — Gerente configura uma impressora 'Produto' diferente para um galpão, mas deixa em branco (sem escolher). Quando imprime, qual impressora o sistema usa?
- [ ] **vou fazer** · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Gerente está configurando as impressoras do galpão SP. Vê 2 tipos de etiqueta: 'Nota fiscal + envio' (impressora Zebra 1) e 'Etiqueta do produto' (deixa em branco). Salva a configuração.
- **Hoje:** Sistema tem um 'plano B': se impressora de 'Produto' está em branco, usa a impressora de 'Envio' no lugar. Se 'Envio' também está em branco, usa a do usuário (operador pode ter uma impressora pessoal). Se nenhuma está configurada, nada imprime.
- **Por que importa:** Gerente precisa saber se 'deixar em branco' é seguro OU se vai quebrar algo. Se confia no 'plano B', deixa em branco para economizar configuração. Se não sabe do 'plano B', fica confuso.
- **Opções:** (A) Deixar como está: se Produto está vazio, usa Envio como fallback → Gerente configura menos coisas. Para maioria dos casos, uma impressora funciona para tudo. Simples.  ·  (B) Exigir que gerente configure AMBAS (Produto E Envio) → Gerente tem que escolher 2 impressoras. Mais controle, mas mais trabalho.  ·  (C) Avisar claramente: 'Se deixar Produto em branco, vai usar Envio' → Gerente entende a escolha e confia na configuração.
- **Recomendação:** Mantenha o fallback (primeira opção) E adicione um aviso claro: 'Deixado em branco: usará a impressora de Envio'. Assim gerente entende o comportamento.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/printnode.ts:379-450

### D077 — Se a conta que fazia a impressão foi cancelada, e o sistema tenta usar outra conta de backup, qual impressora recebe o rótulo — a certa ou erra?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta quando falha
- **Imagina assim:** Rótulo id=xyz foi enviado pra impressora HP Thermal (conta PrintNode A, que foi a oficial). Semanas depois, essa conta foi inativada/cancelada. Operador clica Reimprimir hoje. O sistema detecta que a conta antiga não existe, procura uma conta de backup (conta B, que é a nova oficial). Qual impressora recebe o job — ela consegue processar ou falha?
- **Hoje:** O sistema lembra qual impressora específica foi usada na primeira vez (número interno da impressora). Na reimprimir, tenta enviar para essa mesma impressora. Se a conta B não tem aquela mesma impressora/número, PrintNode retorna erro 404 (impressora não existe).
- **Por que importa:** Rótulos antigos podem precisar ser reenviados meses depois (auditoria, recuperação). Se o sistema falha porque a conta mudou, operador fica sem conseguir reimprimir nada da era antiga.
- **Opções:** (A) Guardar o nome/modelo da impressora em vez de número ID (ex: 'HP Thermal Galpao A'). Reimprimir procura impressora com esse nome na nova conta. → Mesmo que a conta mude, consegue achar impressora equivalente. Mais robusto.  ·  (B) Deixar como está, documentar que 'Reimprimir só funciona enquanto a conta de impressora original estiver ativa'. Se conta mudar, operador não consegue reimprimir logs antigos. → Sem mudança de código. Limitação conhecida.  ·  (C) Reimprimir sempre para a impressora padrão atual (ignorar qual foi a original). Todos os retries usam a impressora ativa de hoje. → Funciona sempre. Mas pode puxar pra impressora 'errada' se houver múltiplas (de foto, de código de barras, etc).
- **Recomendação:** Opção 1 — guardar nome/modelo da impressora, não ID. Mais resiliente a mudanças de conta.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reimprimir/route.ts:84, siso_impressoes_log.printer_id

### D078 — E se um admin muda a empresa de origem do pedido depois que foi aprovado?
- [ ] **vou fazer** · fluxo: Processamento automático de pedidos aprovados
- **Imagina assim:** Um pedido foi aprovado pra ser processado pela Empresa A (com acesso ao Tiny A). Um admin mexe no banco e muda pra Empresa B. A tarefa automática tenta enviar pra Tiny A, que não existe mais ou foi desativada.
- **Hoje:** A tarefa automática falha porque tenta usar credenciais/acesso da Empresa A original (que foi salva no momento da aprovação).
- **Por que importa:** Pedido fica preso. Produto nunca sai do galpão.
- **Opções:** (A) Empresa origem nunca muda (ler-somente na tela) → Impossível mudar sem re-aprovar o pedido. Mais seguro, sem surpresas.  ·  (B) Deixar admin mudar, aceitar que falha e precisa resolver manualmente → Flexível mas arriscado. Admin tem responsabilidade de re-aprovar depois.
- **Recomendação:** Bloquear mudança na tela. Se admin precisar mudar, tem que re-aprovar o pedido com a nova empresa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** execution-worker.ts:278-316


## Tema: Etapas do pedido (separação, embalagem, envio) (37)

### D079 — O sistema deve permitir aprovar um pedido que tem uma linha vazia (item com quantidade zero)?
- [ ] **vou fazer** · fluxo: Aprovação de Pedidos e Compras
- **Imagina assim:** #333: pedido com 2 itens — o primeiro tem 5 unidades, o segundo tem 0. Linha 0 é um erro, ajuste manual ou resquício de cancelamento.
- **Hoje:** O sistema ignora a linha vazia (pula na hora de apartá-la) e processa o pedido normalmente. Ninguém avisa que tem uma linha estranha ali.
- **Por que importa:** Cria dúvida. Seu operador vê no sistema '2 itens', mas só 1 é processado. Quando alguém consulta o histórico, pergunta: cadê o segundo item? Foi cancelado? Ficou pra depois?
- **Opções:** (A) Bloquear a aprovação se houver uma linha com quantidade zero, forçar o operador a deletá-la ou ajustá-la antes. → Mais rigoroso e claro. Mas para o trabalho se houver linhas órfãs.  ·  (B) Deixar aprovar e apenas ignorar as linhas vazias, mas registrar um aviso no histórico. → Operador continua o trabalho e vê um aviso. Mais fluido, mas precisa que o operador leia o aviso.  ·  (C) Aceitar linhas zero como válidas e não apartá-las, documentando explicitamente que 'quantidade zero = não faz parte da separação'. → Simples, direto. Mas confunde quem lê o histórico depois.
- **Recomendação:** Use a opção 2. Sempre deixe o operador seguir o trabalho (ele não pode parar por causa de uma linha legada), mas deixe evidente no aviso: 'item 2 tem quantidade zero — foi ignorado'. Assim, quando alguém perguntar, tem o registro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/aprovar/route.ts:517-518

### D080 — Quando um operador adiciona uma anotação no pedido (tipo 'produto suspeito' ou 'cliente ligou'), isso deveria aparecer no histórico junto com as outras ações do pedido?
- [ ] **vou fazer** · fluxo: Acompanhamento de pedido — do que chega até sair do galpão
- **Imagina assim:** Operador Lucas escreve 'Foto produto suspeita de falsificação' em um pedido. Ele clica em Anotações e vê o comentário dele. Mas quando abre o Histórico, não vê nada — a anotação desapareceu de vista.
- **Hoje:** O sistema separa anotações (comentários) do histórico (ações). Anotações ficam em sua própria aba, histórico mostra só as mudanças de etapa (recebeu, aprovou, separando, etc). São abas diferentes.
- **Por que importa:** Se operador não vê anotações no histórico junto com as ações, pode esquecer que existe um aviso importante (tipo 'conferir autenticidade'). Alguém depois não sabe que precisa revisar.
- **Opções:** (A) Manter como está: anotações em uma aba, histórico em outra aba separada → Operador sempre sabe onde procurar (anotações = aba de anotações). Mais organizado, mas exige que operador tenha disciplina de clicar nas duas abas.  ·  (B) Mostrar anotações também no histórico, juntas com as ações do pedido → Tudo em um único lugar cronológico. Operador vê sequência completa de 'recebeu, aprovou, começou separar, ANOTAÇÃO:foto suspeita, continuou separar, terminou'. Menos cliques.  ·  (C) Mostrar anotações como um aviso destacado no topo do pedido (tipo um post-it) → Anotação nunca é ignorada — sempre visível. Mas se tiver muitas anotações, fica poluído.
- **Recomendação:** Recomendo opção 2 — anotações no histórico também. Pedido é uma sequência de eventos; anotação é um evento que alguém achou importante. Coloca tudo na mesma timeline. Menos cliques, mais seguro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** detalhe/route.ts linhas 89-93 busca observacoes em paralelo; timeline-pedido.tsx nao inclui observacoes (apenas siso_pedido_historico)

### D081 — Um pedido está 'aguardando nota fiscal' mas a nota fiscal nunca chegou — admin pode forçar pra seguir?
- [ ] **vou fazer** · fluxo: Painel de Separação de Pedidos
- **Imagina assim:** Pedido P1 está preso em 'aguardando nota fiscal' há 2 dias porque a NF não foi integrada da loja. Admin clica 'Forçar para Pendente' — o pedido segue mesmo sem NF?
- **Hoje:** Admin clica no botão, o sistema retorna uma mensagem tipo 'X pedidos foram movidos, Y pedidos NÃO têm NF'. O sistema não explica se uma NF é verdadeiramente obrigatória ou se é só um aviso.
- **Por que importa:** Se NF é obrigatória (pra emitir recibo ou enviar pro fisco), forçar é arriscado — pode gerar problema fiscal depois. Se não é obrigatória, o admin está só destrancando um procedimento que travou.
- **Opções:** (A) Permitir forçar, mas deixar claro em vermelho: 'AVISO: Pedido segue sem NF. Isso pode causar problema fiscal.' → Admin sabe exatamente o risco que está tomando e clica sabendo disso.  ·  (B) NÃO permitir forçar se NF é obrigatória — mostrar mensagem: 'Contate o setor de fiscal pra gerar NF' → Força o fluxo correto. Nenhuma surpresa depois.  ·  (C) Deixar como está (ambíguo) — admin decide por conta → Admin fica inseguro, pode não usar a função ou fazer besteira.
- **Recomendação:** Opção 1: permita forçar, mas com aviso em vermelho bem claro. Isso dá ao admin a liberdade pra resolver em um pico (ex: NF atrasada por 3h) mas documenta o risco.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/separacao/page.tsx:473-504

### D082 — Item foi pedido com quantidade zero — operador vê na checklist e tenta marcar. Deixa marcar ou bloqueia?
- [ ] **vou fazer** · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Pedido pede 0 unidades do produto X. Pode acontecer se um item foi cancelado no meio, ou se a integração mandou zero por engano.
- **Hoje:** O sistema provavelmente esconde itens com quantidade zero da tela de checklist. Então operador nem vê.
- **Por que importa:** Se operador conseguir marcar um item de quantidade zero, o sistema não tira nada do estoque (correto), mas o pedido fica estranho — um item que não tem nada.
- **Opções:** (A) Continuar escondendo na tela (filtro). Operador nunca vê. → Simples. Operador não se confunde.  ·  (B) Deixar visível, mas bloquear a marcação com mensagem clara → Operador entende que o item não é pra separar; menos surpresas  ·  (C) Remover itens com zero da lista de compra logo que chegar, antes de ir pra separação → Mais limpo; pedido não tem lixo
- **Recomendação:** A opção 3: remova itens com zero na entrada. Ou, se for um cancelamento que pode chegar depois, use opção 1: esconda na tela.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:87-100

### D083 — Operador marca item, depois desclica (desmarcar), depois marca de novo — o que fica no histórico? Limpo ou cheio de duplicação?
- [ ] **vou fazer** · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Pedido pede 5 unidades. (1) Operador marca: estoque sai de 100 para 95. (2) Desclica: estoque volta pra 100. (3) Marca de novo: estoque sai de 100 pra 95 novamente.
- **Hoje:** Cada ação cria um registro no histórico. Primeira marca = sai 5; desclica = volta 5; segunda marca = sai 5 de novo. Histórico tem 3 registros. O estoque final está certo (95), mas o histórico está cheio de vai-e-volta.
- **Por que importa:** É confuso pra auditoria. Parece que o estoque saiu 3 vezes, quando na verdade saiu 1 vez. Supervisor que tira dúvida fica confuso.
- **Opções:** (A) Limpar o histórico ao desmarcar — deletar os registros antigos, manter só os atuais → Limpo, fácil de entender; perde rastreabilidade completa  ·  (B) Guardar um snapshots da quantidade_pega antes de desmarcar, pra diagnosticar reprocessamento → Histórico continua cheio, mas tem um marcador que explica operador refez  ·  (C) Manter como está (histórico completo). Adicionar um filtro/relatório que mostra só a ação final → Auditoria tem tudo; operador vê resumo limpo
- **Recomendação:** A opção 3. Histórico completo é ouro (auditoria e segurança). Mas crie uma visualização (relatório) que mostra só o estado final.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:317-331

### D084 — Enquanto um operador marca um item, outro operador cancela o pedido inteiro — que ganha?
- [ ] **vou fazer** · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Operador A está separando pedido #123. Marca item X (estoque sai). Ao mesmo tempo, operador B (ou supervisor) cancela o pedido #123 inteiro.
- **Hoje:** Não há sincronismo. Se cancelar sair antes de marcar passar, o item não marca (erro: pedido cancelado). Se marcar sair primeiro, o item fica marcado, mas o pedido é cancelado — inconsistência estranha.
- **Por que importa:** Pedido cancelado com itens parcialmente separados = confusão. Estoque foi retirado, mas pedido não vai sair.
- **Opções:** (A) Bloquear cancelamento enquanto houver itens em marcação (em separação). Só deixa cancelar quando termina. → Seguro, mas operador fica preso se quer cancelar rápido  ·  (B) Deixar cancelar, mas automaticamente desmarcar todos os itens separados (devolver estoque) → Rápido. Estoque volta. Pedido fica limpo.  ·  (C) Avisar operador se há separação em andamento, pedir confirmação → Operador escolhe: cancela mesmo (desfaz tudo) ou não
- **Recomendação:** A opção 2: quando cancelar um pedido, automaticamente desfaça toda separação (devolva estoque). Rápido e seguro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:62-76

### D085 — Operador marca, desclica, marca de novo, desclica, e tenta marcar mais uma vez — o sistema consegue acompanhar tantos desfazimentos/refaços?
- [ ] **vou fazer** · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Pedido pede 5. Operador: marca (L+S 1ª vez), desclica (E+R 1ª vez), marca (L+S 2ª vez), desclica (E+R 2ª vez), marca (L+S 3ª vez). Agora tenta desclica novamente.
- **Hoje:** Cada marca cria registros novos. Desclica estorna todos os registros de marcação encontrados. Pode haver múltiplos pares no histórico. Ao desmarcar a 2ª vez, tenta estornar tudo de novo.
- **Por que importa:** Pareceria que é ineficiente, mas funcionalmente está correto. O estoque fica certo (100-5=95 depois de cada marca final). O risco é confundir operador ou gerar histórico gigante.
- **Opções:** (A) Aceitar como reprocessamento legítimo. Picking é fuzzy; operador pode refazer. Só melhore o diagnóstico no histórico. → Design simples. Operador tem liberdade. Histórico fica cheio mas marcado como reprocessado.  ·  (B) Bloquear reprocessamento (só deixa marcar uma vez, depois desmarcar é final) → Operador erra uma vez, fica preso. Inflexível.
- **Recomendação:** A opção 1. Picking é processo fuzzy. Deixe operador refazer quantas vezes quiser, mas marque no histórico como reprocessamento.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:86-88, 317-330

### D086 — Operador clica duas vezes muito rápido (duplo clique) no botão de marcar — o sistema trata como um ou como dois?
- [ ] **vou fazer** · fluxo: Marcar itens como separados (com scanner ou checkbox)
- **Imagina assim:** Operador toca a tela rápido (duplo clique / toque acidental). Envia dois pedidos de marcar para o servidor quase ao mesmo tempo.
- **Hoje:** O servidor tem proteção: valida se já existe um registro de separação para aquele item. Segundo pedido falha com erro 409 (conflito). Mas a tela não avisa o operador.
- **Por que importa:** Operador não sabe se marcou ou não. Pode ficar esperando.
- **Opções:** (A) Adicionar proteção na tela: desabilitar botão após clique, até resposta chegar → Operador não consegue clicar duas vezes. Simples e rápido.  ·  (B) Manter proteção no servidor (já existe), mas avisar operador com mensagem clara → Operador entende que já marcou; sem confusão
- **Recomendação:** Opção 1: desabilitar botão na tela é mais simples. Evita a confusão antes de sair.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:20-50, src/app/api/wms/reservas-picking.ts:177-206

### D087 — Se o operador clica 'Concluir' duas vezes rapidamente (conexão lenta, ou por acaso), o que faz o sistema?
- [ ] **vou fazer** · fluxo: Finalizar a separação
- **Imagina assim:** Um operador terminou de separar o pedido P-001 (5 itens já guardados), clica em 'Concluir a separação'. A conexão tá lenta. Ele pensa que não funcionou e clica de novo em 100ms.
- **Hoje:** O sistema processa o primeiro clique normalmente (marca o pedido como 'separado'). O segundo clique tenta fazer a mesma coisa, mas descobre que já foi feito. Nesse momento, o segundo clique OU falha (mostra erro), OU faz nada silenciosamente (e o operador não sabe se funcionou).
- **Por que importa:** Se der erro no segundo clique, o operador fica confuso (clicou em um botão dois, recebeu resposta diferente). Se o sistema responde 'ok' e faz nada, o operador pensa que a segunda tentativa também funcionou, quando na verdade já estava feito. Qualquer um desses cenários gera dúvida: 'o pedido foi marcado uma vez ou duas?'
- **Opções:** (A) Deixar como está (segundo clique gera erro) → Operador vê mensagem de erro na segunda tentativa, fica claro que já havia processado. Desvantagem: tela fica com 'erro' mesmo que nada de ruim tenha acontecido.  ·  (B) Fazer segundo clique ser igual ao primeiro → Ambos os cliques sempre retornam 'sucesso' com o mesmo resultado. Operador nunca vê erro. Sistema trata ambos como a mesma ação. Mais amigável.  ·  (C) Bloquear segundo clique antes de processar → Sistema recusa o segundo clique (ex: mostra 'operação já em andamento', fica o botão cinzento). Operador não consegue nem clicar de novo.
- **Recomendação:** Opção 2: o segundo clique deve retornar sempre 'ok' com o mesmo resultado que o primeiro. Assim operador nunca fica em dúvida, não importa quantas vezes clique por acaso.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:233

### D088 — Como o sistema trata um item que pede quantidade zero (ou foi ajustado a zero)?
- [ ] **vou fazer** · fluxo: Finalizar a separação
- **Imagina assim:** Um pedido P-002 foi criado com 1 item: 'Parafuso A' quantidade 5. Depois, ajustaram para quantidade 0 (cancelaram aquele parafuso do pedido). Agora um operador abre a separação e vê o parafuso listado.
- **Hoje:** O sistema deixa o operador marcar o item (clicar checkmark) mesmo com quantidade zero. O sistema processa: item fica marcado como 'coletado', mas nenhuma quantidade sai do estoque (porque é zero). O pedido segue normalmente para 'separado'.
- **Por que importa:** Quantidades zero não deveriam precisar de picking. Se o operador marca como coletado, confunde a sequência de trabalho: parece que ele pegou algo do estoque, mas na verdade pegou nada. Além disso, o registro fica inconsistente (marcado como 'feito' mas sem movimento no estoque).
- **Opções:** (A) Deixar como está (operador marca item com qty zero como qualquer outro) → Operador vê item na lista, marca, sistema aceita, nada sai do estoque. Confuso mas funciona.  ·  (B) Esconder itens com quantidade zero da lista → Operador só vê itens que realmente precisa separar. Mais limpo.  ·  (C) Marcar automaticamente itens com quantidade zero → Sistema marca sozinho sem operador fazer nada. Operador vê já como 'pronto'.
- **Recomendação:** Opção 3 (marcar automático): o sistema deveria marcar itens com quantidade zero como 'já foi' automaticamente, sem operador fazer nada. Assim lista fica leve (só mostra o que realmente precisa) e ninguém fica confuso.
- **➡️ MINHA ESCOLHA:** 
- **Código:** marcar-item/route.ts:87-180

### D089 — Se o sistema não consegue enfileirar a próxima etapa (recebimento do estoque), o pedido fica preso?
- [ ] **vou fazer** · fluxo: Finalizar a separação
- **Imagina assim:** Operador termina de separar o pedido P-003 (5 itens). Sistema marca como 'separado' e tenta enfileirar a próxima etapa (recebimento no depósito). No mesmo instante, o banco de dados fica indisponível 2 segundos.
- **Hoje:** O sistema tenta enfileirar a próxima etapa e falha (banco de dados não respondeu). Ele registra um aviso (log), mas NÃO desfaz o 'separado'. Pedido continua marcado como 'separado', a próxima etapa não foi enfileirada. Operador vê 'ok' (pedido de sucesso), mas a próxima etapa nunca sai do lugar.
- **Por que importa:** Pedido fica congelado entre duas etapas. Parece estar em um estado ok, mas a próxima fase da operação nunca acontece. Operador ou gerente descobre horas depois quando notam que o pedido não saiu do separado.
- **Opções:** (A) Deixar como está (falha silenciosa, operador descobre depois) → Pedido fica preso, descoberta posterior. Risco de atraso na entrega.  ·  (B) Tentar novamente automaticamente a cada X segundos → Sistema tenta novamente em background, sem operador fazer nada. Quando banco voltar, próxima etapa sai sozinha.  ·  (C) Mostrar no painel que há pedidos aguardando próxima etapa → Operador vê em um indicador 'há 2 pedidos aguardando fila'. Assim ele sabe que algo não saiu como planejado.
- **Recomendação:** Opção 2 + Opção 3: sistema tenta novamente automaticamente (em background), E mostra um indicador no painel para operador saber que há algo pendente. Assim pedido não fica invisível, e sistema tenta resolver sozinho.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:283-292, cutover.ts:110-134

### D090 — Quando dois operadores pegam itens do mesmo lugar ao mesmo tempo para pedidos diferentes, qual deles consegue fazer?
- [ ] **vou fazer** · fluxo: Separação de pedidos em prateleiras (quando não tem quantidade completa)
- **Imagina assim:** Cenário 5
- **Hoje:** O primeiro operador consegue. O segundo recebe um aviso de 'lugar ocupado' e tem que esperar ou ir pra outro lugar. MAS se o segundo chegou DEPOIS do primeiro terminar (mas antes do sistema avisar), os dois podem pegar quantidade no mesmo lugar, dobrando a saída.
- **Por que importa:** Se duas pessoas pegam do mesmo pote ao mesmo tempo, a contagem fica errada porque o sistema conta de forma separada.
- **Opções:** (A) Travar o lugar enquanto a primeira pessoa está pegando (ninguém mais consegue tocar) → Seguro 100%. Segundo operador espera ou vai embora. Pode ficar lento se muitos pedidos vêm do mesmo lugar.  ·  (B) Deixar dois pegarem em paralelo mas avisar que é duvidoso (marcar item como 'risco de erro') → Mais rápido, mas seu time de qualidade tem que verificar depois. Mais trabalho de conferência.  ·  (C) Só permitir se forem para a mesma onda (grupo de pedidos que sai junto) → Seguro para produtos que vão juntos. Mas complica se separação é por pedido individual.
- **Recomendação:** Escolha a opção 1. Travar o lugar. Mesmo que fique um pouco mais lento, você não perde a contagem correta.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Separação de pedidos em prateleiras (quando não tem quantidade completa)")

### D091 — Quando operador desfaz e depois avança de novo, deve re-lançar estoque ou reutilizar lançamento anterior?
- [ ] **vou fazer** · fluxo: Desfazer ou voltar etapas da separação
- **Imagina assim:** Pedido em embalagem. Operador clica Desfazer, voltando pra 'em separação'. Depois clica 'avançar' de novo pra volta a embalagem.
- **Hoje:** Sistema reverte a baixa de estoque (estorno de 1 movimento + recriação de reserva). Depois avança novamente e faz um novo lançamento de estoque (mais 1 movimento de saída). Resultado: 2 ciclos completos no o registro das movimentacoes de estoque pra mesma separação.
- **Por que importa:** Auditoria fica pesada — muitos movimentos pra mesma coisa. Ou fica mais leve se reutiliza o lançamento anterior. Depende se a empresa quer histórico completo de tentativas ou histórico limpo só do final.
- **Opções:** (A) Manter como tá (dois ciclos no o registro das movimentacoes de estoque, histórico completo de tentativas) → Auditoria sabe que houve correção. Mais transparente. Maior volume de dados.  ·  (B) Reutilizar o lançamento anterior em vez de fazer novo (apaga o estorno e mantém lançamento original) → O registro das movimentacoes de estoque mais limpo, menos ruído. Mas perde rastreamento de que houve ajuste — só vê resultado final.  ·  (C) Avisar operador quando volta que vai gerar novo ciclo, deixar escolher se continua ou se cria um 'pause' sem reverso → Operador controla. Mais flexível. Mas interface fica mais complexa.
- **Recomendação:** Opção 1. Manter ciclos completos. Estoque e auditoria devem rastrear cada tentativa. Se depois quiser simplificar relatórios, filtra lançamentos do tipo 'estorno' na exibição.
- **➡️ MINHA ESCOLHA:** 
- **Código:** desfazer-bip/route.ts:121-186, cutover.ts:165-193, voltar-etapa/route.ts:256-271

### D092 — Quando um operador pressiona o mesmo botão duas vezes (scanner duplo), devemos permitir que o mesmo item seja contado duas vezes, ou bloquear?
- [ ] **vou fazer** · fluxo: Embalagem de pedidos e impressão de etiqueta
- **Imagina assim:** Um operador lê um código de barras com o scanner. 500 milissegundos depois (por acidente ou tremor), lê novamente. O servidor recebe dois pedidos quase ao mesmo tempo.
- **Hoje:** Ambos os pedidos são processados. O item é contado duas vezes. Se era pra embalar 2 unidades e o operador escaneou 1, o sistema agora mostra 2 e o operador fica confuso sobre qual foi a entrada correta.
- **Por que importa:** Embalagem errada vira devolução. Cliente acha errado, você paga frete de volta, gasta tempo. Em volume (100 pedidos/dia), 1-2% disso já é prejuízo.
- **Opções:** (A) Aceitar os dois cliques (o que acontece agora) → Simples de fazer. Operador fica confuso. Precisa saber qual entrada foi de verdade. Riscos: embalagem errada sai.  ·  (B) Bloquear: primeira entrada vale, segunda é rejeitada com aviso 'Você já escaneou isso agora há 2 segundos' → Evita duplo-contagem. Claro pro operador. Demanda criar um identificador único para cada requisição e guardar um histórico de 2 segundos.  ·  (C) Automático: o sistema reconhece que é o mesmo operador fazendo duplo-clique, ignora o segundo silenciosamente → Limpo pra quem usa. Funciona bem se conexão for estável. Difícil de implementar sem erros (e se não for duplo-clique de verdade?).
- **Recomendação:** Opção 2: bloquear com aviso. Simples, eficiente, dá feedback ao operador. Codificar um identificador único é padrão de mercado e protege outras rotas também.
- **➡️ MINHA ESCOLHA:** 
- **Código:** bipar-embalagem/route.ts:47-56; migration 20260518_realocacao_fix_pack_embalagem_strict.sql

### D093 — Quando a etiqueta da nota fiscal falha ao imprimir, devemos parar a embalagem ou continuar?
- [ ] **vou fazer** · fluxo: Embalagem de pedidos e impressão de etiqueta
- **Imagina assim:** Um operador terminou de embalar todos os itens de um pedido. O sistema tenta imprimir a etiqueta no roteador de impressão, mas a máquina de impressão está desligada ou sem papel.
- **Hoje:** A embalagem marca-se como 'concluída' mesmo que a etiqueta falhe. O sistema avisa ao operador que houve problema na impressão, mas o pedido continua avançando. O operador pode reimprimir depois usando um botão de 're-impressão'.
- **Por que importa:** Etiqueta é fundamental: sem ela, o pedido não sai do galpão de forma rastreável (e o cliente não sabe quando vai chegar). Se a máquina está com problema, você precisa saber: é um dos primeiros pedidos ou a máquina vai falhar em mais 50?
- **Opções:** (A) Continuar como agora: embalagem OK, etiqueta com melhor esforço → Galpão continua fluindo. Operador reimprimir depois. Risco: se reimpress falhar também, pedido pode sair sem rótulo.  ·  (B) Bloquear embalagem se etiqueta falhar na primeira tentativa → Força resolver o problema (papel na máquina). Seguro. Caro: galpão fica parado esperando impressão arrumar.  ·  (C) Tentar imprimir 3 vezes automaticamente (a cada 10 segundos), depois liberar embalagem se continuar falhando → Meia-termo: espera a máquina voltar (se cair por 15s), depois libera sem punir. Operador ainda pode reimprimir.
- **Recomendação:** Opção 3: 3 tentativas automáticas. Cobre quedas curtas, libera galpão se for problema prolongado, operador reteima depois se precisar. Implementar em 2 horas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** bipar-embalagem/route.ts:236-253; etiqueta-service.ts:68-96

### D094 — Quando dois operadores fazem uma ação ao mesmo tempo no mesmo item — um escaneando, outro clicando em confirmar — qual ganha e qual perde?
- [ ] **vou fazer** · fluxo: Embalagem de pedidos e impressão de etiqueta
- **Imagina assim:** Dois operadores estão embalando o mesmo pedido. O operador A escaneia um item (incrementa quantidade) ao mesmo tempo que o operador B clica em 'Confirmar Item' na tela. Ambas as ações querem mexer no contador do mesmo item.
- **Hoje:** O escaneamento usa uma trava (o sistema trava pra que ninguém mexa ao mesmo tempo). O confirmar-item não usa trava: ele lê a quantidade atual, adiciona 1, e escreve. Se o scan acontecer no meio disso, uma das contagens pode ficar errada. A tela atualiza sozinha a cada 5 segundos, então o operador eventualmente vê o número certo, mas durante aqueles 5 segundos a quantidade pode estar errada.
- **Por que importa:** Item com quantidade errada = embalagem errada = devolução. Se é comum 2 operadores mexerem no mesmo item, esse erro acontece todo dia. Se raro, talvez não valha corrigir.
- **Opções:** (A) Deixar como está: eventual consistency (fica certo em 5s) → Simples de manter. Se operador não prestar atenção, embala errado. Risco aceitável se é raro.  ·  (B) Adicionar trava no confirmar-item também (igual ao scan) → Sempre correto. Um operador espera o outro terminar. Mais lento, mas seguro. Funciona se 2+ operadores no mesmo item é raro.  ·  (C) Criar fila de confirmações: confirmar-item vai pra uma fila que processa 1 por vez → Sem trava, sem espera visível. Sistema processa ordenado em background. Operador não vê trava. Demora codificar (meia dia).
- **Recomendação:** Opção 2: adicionar trava. Rápido de implementar (1-2 horas), seguro, alinha com o resto do sistema. Só faça se 2+ operadores no mesmo item é comum.
- **➡️ MINHA ESCOLHA:** 
- **Código:** confirmar-item-embalagem/route.ts:89-95; RPC linha 80

### D095 — Quando um operador desfaz um bip, temos registro de que foi desfazer ou só do resultado final?
- [ ] **vou fazer** · fluxo: Embalagem de pedidos e impressão de etiqueta
- **Imagina assim:** Um operador bipa 5 unidades de um item. Erra, desfaz 3 vezes. Re-bipa 2 vezes. No final, ficaram 4 unidades embaladas (5 - 3 + 2 = 4).
- **Hoje:** O histórico registra UM evento: 'embalagem concluída'. A quantidade final é 4. Mas não diz: bipa 5, depois desfaz 3, depois re-bipa 2. É só resultado final.
- **Por que importa:** Se há auditoria (CNPJ, fiscal) ou suspeita de roubo, você não consegue rastrear 'esse operador bipou errado ou foi pra bolsa dele?'. Também ajuda a treinar operador (vê se erra muito).
- **Opções:** (A) Deixar como é: só registra resultado final (4 unidades) → Simples. Quantidade está correta. Sem rastreio de tentativas. Se precisar auditar depois, não tem dados.  ·  (B) Registrar cada ação: bipa=5, desfaz=-3, re-bipa=+2 (3 eventos) → Completo. Rastreia tudo. Mais banco de dados, mais lento. Ajuda auditoria.  ·  (C) Resumo: resultado final (4) + metadados (tentativas: 3, operador, horários) → Meio termo. Sabe que houve 3 tentativas, mas não a sequência. Rápido de implementar.
- **Recomendação:** Opção 3: resumo com metadados. Cobre 80% dos casos (auditoria, treinamento), demora 1 hora codificar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** bipar-embalagem/route.ts:185-189

### D096 — Operador volta depois de dias para completar a separação de um item — deixamos ele continuar ou rejeitamos?
- [ ] **vou fazer** · fluxo: Checklist de Separação
- **Imagina assim:** Item com 10 unidades pedidas. Operador pegou 3 ontem, prateleira ainda tem 8. Volta hoje querendo pegar mais 4.
- **Hoje:** Sistema aceita e acumula (3+4=7 registradas no pedido). Gera novo comprovante só do que falta.
- **Por que importa:** Se o pedido mudou de etapa enquanto ele estava fora (aprovação, roteamento pra outro galpão), você quer permitir essa volta atrasada? Afeta quantas horas ele pode esperar antes de voltar.
- **Opções:** (A) Deixar como está: sem limite de tempo → Operador volta em qualquer momento. Prático se há atrasos na fila, mas perde rastreabilidade de quando cada parte foi pegada.  ·  (B) Limite de 24 horas → Operador tem 24h pra completar. Depois disso, precisa registrar como nova tentativa. Mais controle, menos confusão.  ·  (C) Rejeitar completamente → Se não pegou tudo de uma vez, não deixa voltar. Operador é obrigado a registrar quantidade final maior já na primeira vez.
- **Recomendação:** Deixar sem limite. O importante é o resultado (separou tudo?), não quando. Às vezes prateleira trava ou pedido fica em fila — operador volta quando consegue.
- **➡️ MINHA ESCOLHA:** 
- **Código:** flow-021.json#decidir[0]

### D097 — Operador digita 0 na tela de quantidade parcial — o que fazer?
- [ ] **vou fazer** · fluxo: Checklist de Separação
- **Imagina assim:** Operador abre modal de 'registrar quantidade parcial', clica no campo, digita 0 sem querer e envia.
- **Hoje:** Sistema rejeita números negativos, mas deixa 0 passar (e depois não registra nada — silencioso).
- **Por que importa:** Se o operador digitou 0, é quase certamente um erro ou mudança de ideia. Deixar passar silenciosamente confunde: pareceu que foi registrado, mas não foi.
- **Opções:** (A) Bloquear zero no input → Força operador digitar 1 ou mais. Evita erros. Mais seguro.  ·  (B) Interpretar como abandono → Quando digita 0, sistema entende como 'não consegui, volta essa tarefa pra fila'. Mais claro que deixar em aberto.  ·  (C) Deixar passar mas pedir confirmação → Aviso visual: 'Tem certeza que pegou 0? Sim / Não / Voltar depois'. Operador sabe o que fez.
- **Recomendação:** Bloquear zero. Não deixa digitar menos de 1 unidade. Simples, previne erro. Se não conseguiu pegar, ele clica em outro botão tipo 'Voltar depois' (mais claro que 0).
- **➡️ MINHA ESCOLHA:** 
- **Código:** flow-021.json#decidir[1]

### D098 — Como o operador envia o pedido? Tem um botão pra isso na tela?
- [ ] **vou fazer** · fluxo: Marcar pedido como enviado
- **Imagina assim:** Expedição de pedidos prontos para envio
- **Hoje:** Hoje não existe botão na tela. O operador vê a aba 'Pronto pra enviar' mas não tem nada pra clicar. A rota pra enviar só existe nos testes internos do sistema. O operador fecha o processo à mão ou o sistema nunca marca como enviado.
- **Por que importa:** Se o operador não consegue marcar como enviado de dentro do sistema, o rastreamento fica errado. A loja não sabe quando chegou pra sair, e cliente não recebe avisos corretos.
- **Opções:** (A) Adicionar botão 'Enviar' na aba 'Pronto pra enviar' (lado do operador) → Operador clica um botão e o pedido fica marcado como enviado no sistema. Rastreamento atualiza automaticamente.  ·  (B) Deixar como tá (sem botão; só admin marca via outro lugar) → Operador não envia; alguém de fora tem que fazer. Mais etapas manuais, risco de não marcar.  ·  (C) Enviar automaticamente quando o pedido sair da mão do operador (sem botão) → Quando entrega pra transportadora, marca automaticamente. Nenhum clique. Risco: erro de rastreamento se transportadora não pegar no horário certo.
- **Recomendação:** Adicionar botão 'Enviar' na tela. Operador tem controle, registra quando saiu de verdade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** separacao/page.tsx:1052-1078

### D099 — Quando o pedido tem MIX (alguns itens encontrados, outros esgotados), o sistema deve passar para próxima etapa sozinho ou aguardar operador clicar em 'Concluir'?
- [ ] **vou fazer** · fluxo: Validação do estoque quando precisa de compra
- **Imagina assim:** Pedido tem 2 itens da compra: caneta azul (operador marcou encontrei, 5 de 5) e caderno (marcou esgotado, aguardando nova compra). Operador não sabe se aperta 'Concluir' ou espera o sistema fazer algo.
- **Hoje:** Sistema deixa o pedido parado na etapa de validação, esperando operador decidir. Não transita automaticamente. Operador precisa clicar em 'Concluir' manualmente.
- **Por que importa:** Define quanto tempo o pedido fica parado. Afeta velocidade de separação e entrega.
- **Opções:** (A) Passar automaticamente pra 'separação' quando caneta está pronta (mesmo que caderno ainda esteja esgotado) → Caneta sai do galpão rápido. Caderno fica como pendência num pedido separado. Mais rápido, mas pedido original vira 2 pedidos.  ·  (B) Ficar parado, esperando operador resolver (deixar como está agora) → Operador tem tempo pra decidir se quer enviar só a caneta ou esperar caderno chegar. Controle manual, mais lento.  ·  (C) Aviso automático: 'Caneta pronta, caderno esgotado — quer enviar parcial?' → Operador recebe alerta, decide num clique. Balanço entre automação e controle.
- **Recomendação:** Deixe parado (como está agora) até operador clicar 'Concluir'. Dá tempo pra operador avisar cliente sobre atraso. Se quiser acelerar, faça um alerta ao invés de automático.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:604-649

### D100 — Se o operador marca só 4 de 5 itens, consegue terminar ou não?
- [ ] **vou fazer** · fluxo: Conclusão de pedido de compra após recebimento completo
- **Imagina assim:** Um pedido tem 5 produtos listados. O operador só encontrou 4 (1 esgotado no depósito). Marca os 4 e clica 'Concluir'.
- **Hoje:** Hoje o sistema deixa passar. Devolve os 4 marcados como 'prontos' e o pedido volta pra fila aguardando o 5º chegar.
- **Por que importa:** Decide se o pedido sai incompleto pra o cliente ou se fica retido até completar. Afeta o prazo de entrega e a experiência do cliente.
- **Opções:** (A) Exigir 100%: Sistema bloqueia a conclusão e mostra 'Faltam 1 item. Não posso terminar este pedido agora.' → Nunca sai pedido incompleto. Mas fica preso até resolver, pode irritar cliente se item demora.  ·  (B) Permitir parcial: Sistema marca os 4 como 'enviados' (ou 'preparados') e cria uma 'nota' de falta pra seguir depois com o 5º. → Pedido segue na frente, cliente recebe os 4 e depois os demais. Mais flexível, mas precisa de controle pra não esquecer o 5º.  ·  (C) Avisar mas permitir: Sistema avisa 'Faltam 1 item' com botão de CONFIRMAR ou CANCELAR. Se confirmar, sai incompleto. → Meio termo: operador escolhe. Evita acidentes mas deixa a responsabilidade clara.
- **Recomendação:** Exigir 100% por enquanto. Se virar muito frequente (1 a cada 10 pedidos), depois muda pra parcial ou aviso. Assim evita surpresa pro cliente e dor de cabeça no pós-venda.
- **➡️ MINHA ESCOLHA:** 
- **Código:** /concluir-oc/route.ts:118-125

### D101 — Quando operador marca alguns itens como 'coletados' (começou a separação) e depois descobre que faltam e marca como 'esgotado', como o sistema deveria contar o residual (o que ainda falta)?
- [ ] **vou fazer** · fluxo: Criar compra automática quando um pedido chega sem estoque
- **Imagina assim:** Pedido precisa de 5 camisetas. Operador marca 1 coletada (1 de 5 ok). Depois vê que faltam as outras 4 (prateleira vazia). Clica 'Produto Esgotado' pro resto.
- **Hoje:** Sistema calcula: 5 pedidas - 1 coletada = 4 faltantes. Cria compra automática de 4. Também desfaz o aparte da 1 que foi coletada (volta pro monte). Pedido volta pra 'esperando compra'.
- **Por que importa:** Cálculo de residual está certo. O aparte-desfazimento também. Mas se o estoque das 5 chega depois, o sistema pode não conseguir reconectar o pedido (porque pedido já 'saiu' de separação). Pedido fica parado.
- **Opções:** (A) Deixar como está: operador deve aprovar manualmente a reconexão depois → Sistema não tenta reconectar automático. Operador vê 'estoque chegou, aprova de novo'. Extra manual.  ·  (B) Fazer sistema tentar reconectar automático se estoque chega após esgotado → Sem ação extra do operador. Fluxo automático. Leva 2-3 horas pra codificar.
- **Recomendação:** Opção 2. Adicionar lógica de reconciliação: se pedido está em 'esperando compra' por esgotado e o estoque chega, reconecta automático. Elimina travamento.
- **➡️ MINHA ESCOLHA:** 
- **Código:** separacao/produto-esgotado/route.ts:267-379

### D102 — O que fazer quando um operador cai do sistema (desconecta) enquanto está contando?
- [ ] **vou fazer** · fluxo: Contagem de estoque nas prateleiras
- **Imagina assim:** Um operador estava contando as prateleiras. De repente cai a conexão dele ou fecha a tela sem avisar. A prateleira continua 'travada' em seu nome. Um supervisor chega depois vendo 'ainda tem 1 operador nessa contagem' — mas o operador não está mais lá.
- **Hoje:** A prateleira fica marcada como 'em_contagem' e travada pro operador que caiu. O supervisor tem duas saídas: (1) clicar 'Encerrar contagem parcial' pra liberar a prateleira e dar a contagem por incompleta, ou (2) um admin entrar manualmente e 'sair' do operador zumbi (limpar o registro dele). Sem isso, fica travado.
- **Por que importa:** Se ninguém liberar a prateleira, ela fica indisponível pra recontagem. A contagem não avança e você perde tempo esperando alguém intervir manualmente.
- **Opções:** (A) Deixar como está (manual + urgência) → Quando acontecer, um supervisor ou admin desbloqueia manualmente. Simples, mas requer intervenção humana cada vez.  ·  (B) Colocar uma rotina automática que libera travamentos órfãos após 30 minutos → Se um operador cai, em meia hora a prateleira se libera sozinha. Ninguém precisa fazer nada. Mais confortável.  ·  (C) Aumentar o tempo de espera pra 1 hora ou mais → Menos intervenção automática, mas operador tem mais tempo pra voltar. Risco: se não volta, trava mais tempo.
- **Recomendação:** Colocar a rotina de 30 minutos. A maioria dos operadores volta rápido, e 30 min é tempo suficiente. Se não voltar, a prateleira se libera sozinha sem incomodar ninguém.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/inventario.ts linhas 252-278, 690-699

### D103 — Se operador perde internet e fica 'travado' dentro de um recebimento, o sistema deveria liberar sozinho após quanto tempo?
- [ ] **vou fazer** · fluxo: Transferência de estoque entre galpões
- **Imagina assim:** Operador João está recebendo uma transferência. Tela dele trava. Sistema marca 'João está recebendo'. Operador Maria chega 1 hora depois e tenta receber — sistema barra ela.
- **Hoje:** Sistema não libera automaticamente. Fica travado pra sempre até admin limpar via banco de dados.
- **Por que importa:** Você pode ficar sem conseguir receber mercadoria por horas porque um operador caiu de internet. Produtividade cai, galpão trava.
- **Opções:** (A) Liberar automaticamente após 15 minutos → Operador cai, volta pra trabalhar em 15 min — sistema já liberou. Rápido. Risco: se operador só saiu 5 min pra beber água, volta e acha que alguém mexeu.  ·  (B) Liberar automaticamente após 1 hora → Mais seguro (operador realmente caiu). Mas 1 hora é muito tempo — galpão fica travado.  ·  (C) Sem liberar automático; operador clica 'liberar meu lock' quando volta → Mais controle, mas precisa treinar operador e ele pode esquecer.
- **Recomendação:** Opção 1: 15 minutos. Se operador sair pra beber água, volta e vê que foi liberado — recomeça rápido. Se realmente caiu, galpão fica só 15 min parado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:287-294

### D104 — Quando operador clica 'Receber' mas falha (ex: erro de banco de dados), quem é responsável por limpar o travamento?
- [ ] **vou fazer** · fluxo: Transferência de estoque entre galpões
- **Imagina assim:** Operador João reivindicou o direito de receber. Começou a guardar a 1ª caixa. Na 2ª caixa, banco de dados falha (ex: prateleira foi deletada). Sistema não consegue completar.
- **Hoje:** Sistema tenta limpar sozinho (best-effort) — se conseguir, limpa. Se falhar também, fica preso. João fica marcado como 'ainda recebendo'. Só admin consegue limpar via SQL.
- **Por que importa:** Se banco falha, operador fica preso. Não consegue tentar de novo. Precisa de admin manualmente mexer no banco para liberar. Operação fica muito dependente de admin.
- **Opções:** (A) Sempre desfaz tudo que foi feito e libera o travamento → João cai, Maria consegue tentar receber de novo. Automático, operador não precisa fazer nada. Limpo.  ·  (B) Deixa como está (best-effort) — sistema tenta limpar, mas se falhar, fica travado → Hoje. Admin precisa intervir. Mais trabalho, menos automático.
- **Recomendação:** Opção 1: sempre desfaz tudo que foi feito. Se erro acontece, volta ao início, libera o travamento e mostra pro operador qual foi o problema específico (ex: 'Prateleira foi deletada'). Assim ninguém fica travado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:390-403

### D105 — E se o operador tenta marcar um pedido que mudou de etapa?
- [ ] **vou fazer** · fluxo: Separação de Pedidos (operador marca itens conforme apanha do galpão)
- **Imagina assim:** Operador A estava marcando um pedido. Enquanto isso, o gerente cancelou o pedido ou o moveu de etapa
- **Hoje:** Sistema permite marcar apenas se o pedido estiver em estados permitidos (em separação, aguardando separação, aguardando compra, aguardando realocação). Mas tem uma janela de tempo entre o sistema ler 'qual é a etapa' e tentar registrar a marcação. Nessa janela, outro usuário pode mudar a etapa.
- **Por que importa:** Se não bloquear direito, você marca estoque de um pedido que foi cancelado, ou que virou uma compra de fornecedor. Estoque fica desalinhado com a realidade.
- **Opções:** (A) Verificar a etapa no começo, e se mudar no meio, erro 400: 'pedido saiu dessa etapa' → Operador recebe aviso que algo mudou, tenta de novo. Mas a janela de risco ainda existe.  ·  (B) Ao tentar registrar, verificar a etapa NAQUELE MOMENTO: se não bate, recusa a marcação → Mais seguro. Garante que só marca se a etapa é válida naquele exato instante.
- **Recomendação:** Escolher opção 2. Quando operador clica em marcar, o sistema verifica no último segundo 'a etapa ainda é válida?' Se alguém mudou de etapa, recusa no ato. Sem risco de janela.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:62-76

### D106 — Item marcado duas vezes por clique duplo — como não inserir a saída duas vezes?
- [ ] **vou fazer** · fluxo: Separação de Pedidos (operador marca itens conforme apanha do galpão)
- **Imagina assim:** Operador clica para marcar um item. Clica de novo por acaso (duplo clique ou desfez e refez)
- **Hoje:** Sistema cria dois registros de saída (duas movimentações L e S). O primeiro pode ficar ok, mas o segundo tenta inserir novo registro de saída para o mesmo item. Pode gerar erro de duplicação ou contar saldo duas vezes.
- **Por que importa:** Se contar a saída duas vezes, você marca 5 unidades mas o sistema baixa 10 (duas vezes 5). Saldo fica errado. Ou pode gerar erro na base de dados e travar a separação.
- **Opções:** (A) Verificar antes: se o item já foi marcado com essa quantidade, não insere novo registro. Retorna ok. → Simples. Duplo clique vira clique único.  ·  (B) Usar um identificador único por marcação. Se chega a mesma marcação, base de dados rejeita a inserção duplicada → Mais robusto. Impossível duplicar mesmo se o código não verificar.
- **Recomendação:** Escolher opção 2 (com apoio da opção 1). Colocar uma chave única no banco para evitar duplicação. E no código, verificar antes de tentar inserir — assim avisa ao operador 'já marcado' em vez de gerar erro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/marcar-item/route.ts:82-88

### D107 — Quando o preço muda entre clicar em 'Ver disponível' e clicar em 'Criar venda', deve falhar ou criar mesmo assim de um jeito limitado?
- [ ] **vou fazer** · fluxo: Venda Manual (consulta de estoque + criação de pedido)
- **Imagina assim:** Vendedor clica em 'Ver disponível' de um produto e o sistema fala: tem 5 unidades na prateleira 1. Vendedor começa a digitar a venda. Mas no mesmo instante, outro operador em outro lugar está criando uma venda do marketplace que baixa aquelas mesmas 5 unidades. Quando o vendedor clica 'Criar', as 5 unidades já não existem.
- **Hoje:** O sistema detecta na hora que não tem mais saldo e não bloqueia a venda — só muda o tipo de pedido. Era pra ser uma venda rápida (baixa direta), mas vira um pedido normal (separação), e o sistema avisa pro vendedor que o produto não tem saldo. O pedido é criado mesmo assim e o separador descobrirá depois que não tem o produto.
- **Por que importa:** Ou você bloqueia a venda (0 risco, mas vendedor fica frustrado), ou você cria mesmo assim pra não perder a venda (risco de prometer pra cliente algo que não tem).
- **Opções:** (A) Deixar como está: muda automaticamente pra separação e avisa → Venda não cai, mas pode comer estoque de outro lugar (operador surpreso depois)  ·  (B) Bloquear: mostra erro 'Não tem estoque, tenta de novo' → Vendedor sabia o risco e refaz a consulta; zero surpresas; mas precisa de retry  ·  (C) Deixar criar, mas marcar o pedido em vermelho pra admin resolver → Venda funciona, mas você vê no painel que tem risco; admin decide depois se cancela ou acha estoque em outro galpão
- **Recomendação:** Escolha conforme sua operação: se quer garantia total (opção 2), bloqueia. Se quer evitar perder venda (opção 3), marca em vermelho. Não deixa silencioso mudando tipo de pedido sem avisar claro pro vendedor — isso confunde.
- **➡️ MINHA ESCOLHA:** 
- **Código:** criar/route.ts:349-365

### D108 — Deixar pedido em estado inválido ou obrigar estar em estado válido?
- [ ] **vou fazer** · fluxo: Cancelamento de Vendas
- **Imagina assim:** Um pedido está marcado como 'em execução' mas o campo de 'etapa interna de separação' é vazio (ninguém sabe se foi separado ou não).
- **Hoje:** O sistema não valida essa combinação. Permite que um pedido tenha essa mistura confusa de informações. Quando o vendedor cancela, o sistema não sabe se tira estoque de um lugar ou outro — fica ambíguo.
- **Por que importa:** Um pedido deve estar sempre em um estado que faça sentido: ou não foi começado a separar, ou está sendo separado agora, ou foi separado. Não pode ser '?' e '?'. Isso abre brechas pra decisões erradas no cancelamento e dificilmente você consegue auditar o que realmente aconteceu.
- **Opções:** (A) Deixar como está (sem validação) → Pedidos confusos entram e saem do sistema. Cancelamentos podem não fazer efeito porque o sistema não sabe qual etapa ele está.  ·  (B) Forçar que quando um pedido é criado, ele sempre tem um estado + etapa válidos (ex: 'pendente' com etapa 'não iniciada') → Toda vez que o vendedor vê um pedido, ele sabe exatamente onde está. Cancelamento é previsível.
- **Recomendação:** Opção 2. Garantir que nunca existe combinação inválida. O investimento inicial é pequeno (validação) mas economiza muito tempo em diagnósticos depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** flow-055

### D109 — Quando um pedido já está sendo separado e a mercadoria do fornecedor chega, o sistema tira ele da separação normal e joga numa separação especial (cross-dock). Mas e se o pessoal já começou a separar na prateleira? O sistema deve ignorar esse pedido (deixar separando normal) ou forçar a separação especial mesmo assim?
- [ ] **vou fazer** · fluxo: Detecção automática de saídas diretas do recebimento
- **Imagina assim:** Dia 02/06, 10h: Pedido 000456 começa a ser separado. Dois itens já foram pegados na prateleira. 10h15: O fornecedor entrega a mercadoria que faltava pro pedido. O sistema detecta e quer fazer uma separação especial (misturando estoque que estava lá com estoque que acabou de chegar). O pessoal na separação não sabe e continua pegando da prateleira.
- **Hoje:** O sistema detecta o pedido e força a mudança de status pra separação especial, mesmo que o pessoal já tenha começado a trabalhar nele.
- **Por que importa:** Se o sistema força e o pessoal não fica sabendo, pode juntar mercadorias de dois caminhos diferentes (estoque velho + estoque novo) no mesmo pacote. Ou pior: o pessoal termina de separar do jeito antigo, mas o sistema acha que é separação especial.
- **Opções:** (A) Sistema ignora pedidos que já estão 'em separacao' ou 'separado' — deixa como está (separação normal mesmo) → Mais seguro. Evita surpresas no meio do processo. Mas o estoque que chegou novo não participa dessa venda — fica de fora.  ·  (B) Sistema força mesmo assim, e avisa o pessoal (notificação visual ou lista separada pra revisar) → Aproveita o estoque novo. Mas exige que o pessoal saiba da mudança e refaça a separação. Mais trabalho manual, mais chance de erro.  ·  (C) Sistema só força se o pedido AINDA não começou a ser separado (parar antes de mexer) → Equilibra segurança e aproveitamento. Funciona bem se a separação é rápida.
- **Recomendação:** Opção 3. Se o pessoal não mexeu ainda (status=aguardando_separacao), muda pra separação especial e aproveita o estoque novo. Se já mexeu (status=em_separacao), deixa como está e loga o evento pra você ver depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Detecção automática de saídas diretas do recebimento")

### D110 — Item em pedido antigo referencia kit que virou não-kit — atualiza retroativamente?
- [ ] **vou fazer** · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Pedido antigo (de mês passado) tem um item que é 'kit' (2 peças). Hoje você sincroniza e produto vira 'não-kit' no sistema. Item antigo do pedido ainda aponta pro kit antigo.
- **Hoje:** Novo pedido vindo do Tiny se expande correto (trata como não-kit). Mas o item antigo fica preso em referência que não faz mais sentido — aponta pra kit que não existe mais. Pedido antigo não se atualiza.
- **Por que importa:** Se precisar reabrir ou clonar pedido antigo, vai sair com composição errada. Separador se confunde se vê '1 kit' ou '2 peças'.
- **Opções:** (A) Deixar pedidos antigos como estão (sem retroativo) → Pedidos históricos ficam congelados, ok. Mas se alguém tenta reabrir (devolução), sai errado.  ·  (B) Quando produto muda tipo, atualizar todos os itens de pedido antigos que referenciam ele → Todos os pedidos ficam consistentes com novo tipo. Mas pode ser arriscado se mudança não foi intencional.  ·  (C) Avisar ao operador que há pedidos antigos afetados, deixar ele escolher atualizar → Transparente. Operador avalia se é seguro.
- **Recomendação:** Avisar ao operador. Não atualize retroativamente sem permissão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

### D111 — E se o operador clicar botão Aprovar 2 vezes muito rápido no mesmo pedido com kits?
- [ ] **vou fazer** · fluxo: Produtos que são feitos de componentes (Kits)
- **Imagina assim:** Pedido com kit, botão Aprovar, operador clica 2× em menos de 1 segundo
- **Hoje:** Sistema checa se já tem reservas; se tem, ignora a 2ª tentativa. Janela de risco: entre ler o pedido e começar a apartar estoque, 2 cliques podem passar.
- **Por que importa:** Se ambos os cliques viram aprovações de verdade, aparelha o mesmo estoque 2 vezes — o pedido usa estoque que não tem, ou o saldo fica negativo.
- **Opções:** (A) Deixar como está (risco pequeno, <500ms na tela) → Funciona 99% das vezes; se acontecer, descobrimos post-mortem e ajustamos  ·  (B) Bloquear no banco de dados com regra rigorosa (tudo-ou-nada) → Garante que nunca duplica, mesmo com operações rodando em paralelo; mais seguro, precisa migração  ·  (C) Desabilitar botão após 1º clique → Impede clique duplo na tela; mas se vier de operação interna, não para
- **Recomendação:** Se 99% dos acessos é tela Web (operador), opção 3 é suficiente e rápida. Se tem operação ou integração paralela, fazer opção 2 — adicionar validação no banco de dados para garantir que executa uma vez só.
- **➡️ MINHA ESCOLHA:** 
- **Código:** aprovar/route.ts:428-436

### D112 — O que acontece se o operador apertar o botão 'Imprimir' duas vezes em 1 segundo?
- [ ] **vou fazer** · fluxo: Impressão de etiquetas para guardar mercadoria
- **Imagina assim:** Um operador está separando mercadoria. Tem 5 etiquetas pra imprimir. Bate duplo clique no botão. No mesmo instante, o navegador envia 2 ordens de impressão.
- **Hoje:** As 2 ordens chegam. Cada uma vira 5 etiquetas. A impressora recebe 2 trabalhos e solta 10 folhas (em vez de 5). O sistema registra as 2 impressões como bem-sucedidas no histórico — ambas aparecem como 'sucesso' com datas iguais.
- **Por que importa:** O operador pensa que imprimiu uma vez só, mas desperdiça papel e tinta. Pior: pode levar 10 etiquetas pro galpão, cola em 5 caixas erradas, e depois cria confusão no rastreamento de pedidos (quem recebeu 2 etiquetas de um mesmo produto?).
- **Opções:** (A) Desabilitar o botão enquanto a impressão está acontecendo (travá-lo por 2-3 segundos) → Operador não consegue clicar 2x. Seguro, rápido, sem desperdício.  ·  (B) Manter como está (operador responsável por não clicar 2x) → Economiza código, mas depende do operador estar atento. A cada 100 impressões, talvez 1-2 acidentes de duplo clique.
- **Recomendação:** Desabilitar o botão enquanto imprime. Custa quase nada, elimina erros de clique duplo e poupa papel. Comportamento padrão em qualquer formulário web que funciona bem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** etiqueta-produto-service.ts:67-73

### D113 — Imprimiu as etiquetas, mas depois a guarda falha — as etiquetas já saíram de graça?
- [ ] **vou fazer** · fluxo: Impressão de etiquetas para guardar mercadoria
- **Imagina assim:** Operador imprime 5 etiquetas de um produto de R$200 pra guardar na prateleira C15. Sai 5 folhas da impressora. Depois clica em 'Confirmar Guarda', mas a prateleira C15 foi desativada por outro operador 30s antes. Confirmar falha e volta a erro.
- **Hoje:** Sistema registra 'impressão = sucesso' no histórico. Mas a guarda fica presa em status 'em progresso' (ou volta pra 'pendente'). As 5 etiquetas já foram impressas — estão na mão do operador ou caíram na bancada.
- **Por que importa:** A etiqueta é o documento de rastreamento. Se saiu de graça mas o produto nunca foi guardado (porque falhou), fica órfã: está etiquetada mas não registrada onde está. Depois, quando procurarem a peça, não a acham. Cliente reclama atraso no pedido.
- **Opções:** (A) Imprimir SÓ DEPOIS de garantir que a guarda vai dar certo (deslocador de fluxo) → Mais seguro: etiqueta e guarda são um evento só. Mas exige recódigo maior (precisa validar prateleira antes de imprimir).  ·  (B) Imprimir antes (como hoje) mas avisar ao operador: 'Cuidado, se confirmar falhar, etiquetas são lixo' → Operador sabe do risco. Se falhar, ele descarta as folhas ou reimprimi depois. Rápido, mas responsabilidade dele.  ·  (C) Ter um botão 'Desfazer Impressão' que aproveita as folhas de novo → Bem-intencionado, mas na prática não funciona: etiqueta perdida em uma caixa de papel descartado é muito difícil de recuperar.
- **Recomendação:** Manter como hoje, MAS avisar ao operador em tela bem clara: 'Após imprimir, não será possível cancelar a guarda sem desperdiçar as etiquetas'. Assim ele sabe que tem de conferir a prateleira ANTES de apertar Imprimir.
- **➡️ MINHA ESCOLHA:** 
- **Código:** etiqueta-produto-service.ts:154-161

### D114 — Existem dois tipos de rótulos diferentes (de envio do pedido e de recebimento de compra). Reimprimir funciona igual em ambos?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta quando falha
- **Imagina assim:** Operador está vendo a tela com rótulos com erro. Aparece: (1) rótulo de envio (aquele que gruda na caixa do cliente) — erro ao imprimir. (2) Rótulo de recebimento (para guardar a compra de fornecedor na prateleira) — erro também. Operador clica Reimprimir em ambos. Os dois funcionam? Ou um não funciona completamente?
- **Hoje:** Ambos reimprimem (o desenho sai de novo pela impressora). MAS: o rótulo de envio tem um passo adicional que não roda no segundo clique — o sistema não atualiza o status do pedido para 'etiqueta pronta'. Parece que funciona, mas falta um passo interno.
- **Por que importa:** Rótulo de envio é crítico — o pedido só segue se a etiqueta estiver 'pronta'. Se reimprimir não atualizar esse status, o pedido pode ficar travado e não sair para separação.
- **Opções:** (A) Consertar o Reimprimir para rótulos de envio — fazer tudo que faz a primeira vez (não só reimprimir, mas também marcar 'pronto') → Rótulo de envio funciona completo no retry. Exigir refatoração de código.  ·  (B) Deixar como está (rótulo sai, status manual). Criar alerta ao operador: 'Rótulo de envio reenviado — atualize manualmente o status do pedido' → Sem mudança de código. Mas operador pode esquecer e pedido fica pendurado.  ·  (C) Desabilitar Reimprimir para rótulos de envio — criar uma rota separada só pra eles, com todo o fluxo correto → Mais seguro, evita estado inconsistente. Mas quer dizer: operador não consegue reimprimir de envio direto dessa tela.
- **Recomendação:** Opção 1 — consertar o fluxo de reimprimir para rótulos de envio. É crítico não ficar faltando o passo de atualizar status.
- **➡️ MINHA ESCOLHA:** 
- **Código:** retry/route.ts, etiqueta-service.ts:160

### D115 — Se o pedido for movido para 'expedido' enquanto o operador está reenviando a etiqueta, o sistema deveria permitir ou bloquear a reimpressão?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta de separação
- **Imagina assim:** Operador A clica 'Reimprimir' com o pedido #1234 embalado. Enquanto o clique está viajando pela rede pro servidor (2 segundos), Operador B move o pedido #1234 para 'expedido' (porque terminou de conferir e quer ir embora). Operador A vê erro: 'Não consegui porque o pedido não está mais embalado'.
- **Hoje:** Sistema rejeita reimpressão com erro 400. Operador vê mensagem de erro. Nenhuma etiqueta é impressa. Se o pedido já foi expedido, o sistema assume que já saiu do galpão e bloqueia.
- **Por que importa:** Se um pedido sai do galpão e vamos notar depois que a etiqueta saiu errada (imprensa perdeu, código errado), a gente quer poder consertar ainda. Bloqueando reimpressão em 'expedido', a gente fica sem opção.
- **Opções:** (A) Permitir reimprimir mesmo se o pedido já foi expedido → Operador consegue corrigir depois. Mas precisa avisar o cliente ou recircular a etiqueta depois que partiu.  ·  (B) Bloquear como hoje (rejeitar se não está em 'embalado') → Seguro: garante que reimpressão só acontece quando pedido ainda está no galpão. Operador tem que ser rápido.  ·  (C) Avisar ao operador que o status mudou, mas permitir uma última reimpressão se quiser → Equilibrado. Avisa que correr risco, mas deixa escolher.
- **Recomendação:** Opção 2. Manter bloqueado. Justificativa: etiqueta de envio deveria ser corrigida ANTES de sair do galpão. Se já saiu, é muita complicação depois. Recomendo que o botão 'Reimprimir' desapareça da tela quando status virar 'expedido', assim operador vê na hora que não consegue mais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:40-62


## Tema: Inventário e acertos de saldo (30)

### D116 — Como lidar com estoque que deveria ter quantidade, mas foi registrado com zero? Cancelar de forma especial?
- [ ] **vou fazer** · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Um pedido anterior deixou um registro de estoque apartado, mas com quantidade zerada (bug anterior na hora de apartar).
- **Hoje:** Quando o operador tenta cancelar, o sistema nega dizendo 'quantidade deve ser maior que zero'. O registro fica pendurado sem conseguir estornar.
- **Por que importa:** O estoque apartado não sai de cena — fica como 'fantasma'. O saldo não bate. Ocupar espaço em fila sem ser resolvido.
- **Opções:** (A) Criar um menu de 'limpeza' que encontra esses registros zerados e deleta → Rápido. Mas perde auditoria de 'por que foi zerado'.  ·  (B) Permitir cancelamento de quantidade zero sem validação → Simples. Mas pode esconder bugs de roteamento.  ·  (C) Forçar operador a consultar manualmente e corrigir no banco → Ninguém faz. Fica quebrado.
- **Recomendação:** Criar um relatório que mostra 'registros zerados' e permitir botão 'descartar' que deleta com auditoria. Também corrigir no roteamento pra não criar quantidade zero.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:44-62

### D117 — Quando operador marca 'prateleira vazia' mas não pegou nada (digita 0), o sistema registra que sumiu estoque inteiro. Isso está certo ou erra?
- [ ] **vou fazer** · fluxo: Separação de pedidos em prateleiras (quando não tem quantidade completa)
- **Imagina assim:** Cenário 4
- **Hoje:** Sistema cria um ajuste que marca aquele lote inteiro como desaparecido (perda inexplicada). Se o operador volta depois e acha as coisas lá mesmo, ele pega = contagem fica o dobro do que deveria.
- **Por que importa:** Se você tem 50 peças, operador marca 'zerada' sem pegar nada, sistema acha que desapareceram 50. Depois que descobre que estão lá, ele pega 50 mesmo (acha que é falta). Viram 100 na sua contagem.
- **Opções:** (A) Deixar como está: 'zerada' registra desaparecimento; depois o operador ajusta manualmente → Seu time de inventário é quem arruma. Leva tempo, mas deixa claro o que era erro de digitação vs. perda real.  ·  (B) Mudar: 'zerada' só marca a prateleira como vazia, não cria desaparecimento. Depois, de fundo, o sistema confere → Desaparecimento só é registrado se ninguém tiver achado nos próximos 2-3 dias. Mais seguro.  ·  (C) Exigir foto ou assinatura do supervisor quando marca zerada → Operador tem que confirmar com chefe. Evita cliques errados. Leva mais 30 segundos por prateleira.
- **Recomendação:** Escolha a opção 2. Sistema seguro de fundo. Desaparecimento só é real se persistir. Operador que marcou errado não afeta seu inventário.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Separação de pedidos em prateleiras (quando não tem quantidade completa)")

### D118 — O que fazer se o operador digita zero na contagem de uma prateleira?
- [ ] **vou fazer** · fluxo: Contagem de Estoque em Ciclo
- **Imagina assim:** Operador vai contar prateleira C3 (que deveria ter 150 unidades de Parafuso 6mm). Digita 0 por engano (ou confirma vazio por acidente).
- **Hoje:** O sistema aceita 0 sem reclamar. Registra: contei zero. Quando o supervisor aprova, o sistema calcula falta de 150 unidades.
- **Por que importa:** Zero pode ser verdade (prateleira mesmo vazia) ou engano do operador. Sem validação, fica ambíguo. Se for engano, supervisor aprova falta falsa e depois precisa desfazer tudo.
- **Opções:** (A) Bloquear zero completamente — operador é obrigado a registrar pelo menos 1 ou marcar como 'conferido vazio' com botão especial → Força operador a pensar. Se prateleira está mesmo vazia, clica o botão 'vazio confirmado' em vez de digitar 0. Fica claro que foi intencional.  ·  (B) Permitir 0, mas exigir revisão extra antes de supervisor aprovar — supervisor vê aviso laranja → Aceita engano do operador, mas força supervisor a olhar. Menos rigoroso, mas mais flexível.  ·  (C) Permitir 0 e tratar como verdade — se prateleira tem saldo, é falta real; se não tem, é consistente → Sem proteção extra. Deixa risco de engano do operador passar despercebido.
- **Recomendação:** Opção 1: crie um botão 'Prateleira Vazia Confirmada' separado do campo de número. Quando operador clica, o sistema sabe que foi intencional, não engano.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:488-555

### D119 — Supervisor aprovou ganho de 50 unidades de um produto. Depois quer desfazer só esse ganho, não toda contagem.
- [ ] **vou fazer** · fluxo: Contagem de Estoque em Ciclo
- **Imagina assim:** Sessão com 8 prateleiras contadas. Prateleira A1: ganho de 50 caixas. Prateleiras B1-B7: tudo certo. Supervisor aprova tudo. Depois nota que A1 foi contada errado e quer reverter só o ganho de A1.
- **Hoje:** O sistema não tem botão de 'reverter só este produto'. Supervisor só pode desfazer TODA a sessão (todas as 8 prateleiras), o que desfaz os 7 certos também.
- **Por que importa:** Se supervisor é forçado a desfazer tudo, operadores de novo precisam recontar as 7 prateleiras boas. Retrabalho + risco de erros novos.
- **Opções:** (A) Permitir 'desfazer produto individual' — supervisor clica em A1 e reverte só aquele ganho → Cirúrgico. Operadores não perdem o trabalho. Mais complexo de implementar, mas mais prático.  ·  (B) Manter do jeito atual — só desfaz tudo ou nada, supervisor reprocessa → Simples de manter. Mas causa retrabalho e frustração.
- **Recomendação:** Opção 1: adicione 'Reverter só este ganho' como ação no futuro. Mas por enquanto, mantenha avisado que desfazer é operação nuclear — tudo sai.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:1161-1226

### D120 — Sessão fica pronta pra contar, mas ninguém entra no fim de semana. Segunda-feira, ninguém entrou ainda. Prateleiras da sessão ficam trancadas pra estoque normal?
- [ ] **vou fazer** · fluxo: Contagem de Estoque em Ciclo
- **Imagina assim:** Supervisor cria sessão na sexta pra contar 20 prateleiras. Sai de férias. No fim de semana e segunda, ninguém toca. Estoque normal (fora da contagem) tenta mexer com uma dessas prateleiras.
- **Hoje:** Prateleiras da sessão ficam 'trancadas' (reservadas pra contagem). Ninguém consegue mexer (receber mercadoria, picking, reloca). Podem ficar dias assim.
- **Por que importa:** Estoque normal fica penalizado. Entrada de mercadoria bloqueia. Picking fica fora de questão. Negócio sofre.
- **Opções:** (A) Limpeza automática: se sessão ficar em 'planejada' > 24h, destranca automaticamente (operadores podem bipar de novo ou supervisor cancela) → Automático e seguro. Após 24h, estoque volta ao normal, supervisor precisa recriar se ainda quiser contar.  ·  (B) Manter como está — supervisor cancela manualmente quando notifica que parou → Depende de supervisor lembrar. Risco alto de tranca involuntária.
- **Recomendação:** Opção 1: implemente limpeza automática após 24h. É seguro e evita travamentos acidentais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:126-172

### D121 — Produto novo em estoque (nunca entrou compra) — tem ganho em contagem. Qual custo registra?
- [ ] **vou fazer** · fluxo: Contagem de Estoque em Ciclo
- **Imagina assim:** Contagem descobre 100 unidades de Luva Latex não cadastradas no saldo. Sistema aprova como ganho. Depois tenta registrar valor (custo unitário) pra rastrear movimentação.
- **Hoje:** Se produto não tem custo médio definido (porque nunca entrou compra), o sistema deixa custo em branco. Movimento financeiro registra 0 ou fica inrastreável.
- **Por que importa:** Você não sabe o valor real que ganhou. Relatório de divergências não mostra impacto financeiro. Auditoria depois fica cega pra movimentação de valor.
- **Opções:** (A) Bloquear aprovação de ganho até supervisor informar custo estimado (ou usar custo de última compra se existe) → Força decisão consciente. Supervisor sabe que está registrando valor. Rastreabilidade garantida.  ·  (B) Usar custo 0 explicitamente — registra ganho mas custo fica zerado (marca como 'ganho não precificado') → Permite aprovação rápida. Mas relatório de valor fica impreciso.  ·  (C) Permitir aprovação com custo vago — descobre depois em relatório → Rápido agora, complicado depois. Pode deixar divergência financeira invisível.
- **Recomendação:** Opção 1: durante aprovação, se custo está faltando, mostre aviso ('Custo não definido — usar valor estimado?'). Força supervisor a escolher consciente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:1023-1033

### D122 — Se uma contagem ficar aberta por dias, posso reutilizá-la ou preciso fazer nova?
- [ ] **vou fazer** · fluxo: Verificação de Estoque na Hora da Separação
- **Imagina assim:** Um operador abre uma sessão de contagem no galpão na segunda-feira. Conta 2 prateleiras, salva e sai. Voltam na sexta (5 dias depois) pra continuar contando as outras prateleiras. O sistema reutiliza a mesma sessão de segunda?
- **Hoje:** Sim, o sistema reutiliza. Se a mesma sessão estiver aberta, um novo clique na quinta-feira vai procurar a sessão antiga e continuar ali. Se o saldo daquela prateleira mudou nos 5 dias (porque outros pedidos foram separados), a contagem anterior fica incorreta ou é sobrescrita com o novo saldo.
- **Por que importa:** Seu histórico de contagem fica confuso. Você não sabe mais o que foi contado quando, ou qual era o saldo verdadeiro naquele dia. Se precisar provar "contei 8 na segunda" mas o sistema sobrescreveu com "3 na sexta", perdeu a informação.
- **Opções:** (A) Manter sessão aberta indefinidamente (como hoje) → Contagem pode virar histórico bagunçado. Bom pra casos raros onde alguém volta dias depois.  ·  (B) Fechar sessão automaticamente após X dias e criar nova se voltar depois → Cada dia de contagem é uma sessão separada. Histórico claro, rastreável. Operador vê que é novo dia, novo contexto.  ·  (C) Guardar contagem em linha separada, não sobrescrever → Você tem dois registros — contagem de segunda (8 unidades) + contagem de sexta (3 unidades). Sabeque mudou, mas precisa de lógica pra decidir qual vale.
- **Recomendação:** Feche sessão após alguns dias (digamos, 3-5 dias) e crie nova. Deixa seu histórico claro e acionável. Depois você sabe: segunda tive 8, sexta tive 3, logo consumiram 5.
- **➡️ MINHA ESCOLHA:** 
- **Código:** contagem-inline.ts:27-29, 35-70, 154-171

### D123 — Supervisor pode computar divergências enquanto operador ainda está contando?
- [ ] **vou fazer** · fluxo: Contagem de estoque por prateleira (digitar quantidades que vê)
- **Imagina assim:** Supervisor quer clicar no botão 'computar divergências' (gerar o relatório de diferenças encontradas). Porém, um operador ainda está lá contando produtos em uma prateleira.
- **Hoje:** O sistema checa se tem operador ativo (contando agora). Se tiver, retorna erro e bloqueia o supervisor. Supervisor recebe uma lista de nomes: 'ainda tem 1 operador contando: João em A03'. Existe um switch 'forçar mesmo assim', mas é invisível no seu painel — só dev consegue ativar.
- **Por que importa:** Se supervisor computar enquanto operador ainda está contando, os números que operador digitar depois não entram na conta. Fica divergência calculada com dados incompletos. Operador não sabe que contagem dele foi deixada de fora.
- **Opções:** (A) Deixar como está: bloquear, mostrar quem está contando, deixar supervisor abortar ou forçar → Seguro por default. Supervisor tem que mandar operador parar. Se força, assume risco e consegue proceder.  ·  (B) Deixar supervisor computar mesmo com operador ativo, sem avisar → Mais rápido, mas operador fica surpreso quando contagem dele some e supervisor tem que explicar depois.  ·  (C) Auto-finalizar operador ativo quando supervisor clica computar → Automático, mas operador perde o trabalho já digitado se não finalizou a prateleira.
- **Recomendação:** Deixar como está. Bloquear por default é a abordagem certa. Supervisor deve conferir se todo mundo parou de contar (botão de parar que visibiliza a lista 'ainda ativo: [nomes]'). Se precisar mesmo assim forçar, deixa, mas deixa visível no painel.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts linhas 691-699

### D124 — Quando chega estoque entre calcular divergências e aplicar a contagem, a contagem fica certa?
- [ ] **vou fazer** · fluxo: Contagem de estoque por prateleira (digitar quantidades que vê)
- **Imagina assim:** Era 14h. Supervisor calculou as divergências da contagem — sistema disse 'diferença de +2 camisetas na prateleira A05' (achamos 12, sistema dizia 10). Entre 14h e 14:05 chega uma compra do fornecedor (5 camisetas para A05). Às 14:05, supervisor clica aplicar contagem.
- **Hoje:** Sistema calcula divergência usando estoque que existia às 14h. Quando supervisor aplica a contagem, o sistema verifica o estoque ATUAL (15 camisetas, porque chegou compra). A aplicação registra movimento de +2, começando do 15 que tem agora. Fim fica 17. Mas a divergência original foi calculada partindo de 10, não de 15.
- **Por que importa:** Os números no final (17) não batem exatamente com a lógica da contagem (contagem dizia 12+diferença pequena=14-15, não 17). Se auditor verificar depois, vê inconsistência: 'divergência de +2, mas movimento foi de +2 sobre base 15, não sobre 10'. Fica pista enganadora de quando estoque mudou.
- **Opções:** (A) Manter como está: aplicar mesmo com estoque chegando no meio → Prático, mas deixa números inconsistentes entre divergência calculada e movimento registrado. Janela de risco são horas entre calcular e aplicar.  ·  (B) Congelar estoque entre calcular divergências e aplicar, não deixa compra entrar → Exato, mas travaria entrada de compra por horas, impacto grande.  ·  (C) Exigir que supervisor calcule e aplique em sequência rápida (máx 10 minutos) → Prático, reduz janela. Precisa de procedimento + timer no painel que pisca se passou muito tempo.
- **Recomendação:** Deixar como está, mas com procedimento claro: supervisor tem que aplicar contagem RÁPIDO depois de calcular (máx 15 minutos). Se deixar dias passarem, risco aumenta e números podem não bater auditoria. Adicione no painel um aviso: 'divergências calculadas há X minutos — aplicar em breve pra não desincronizar com estoque chegando'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts linhas 660-830

### D125 — Contagem vs movimentação: o que vale quando a mercadoria entra enquanto está contando?
- [ ] **vou fazer** · fluxo: Contagem de estoque nas prateleiras
- **Imagina assim:** Operador contou a prateleira L1 às 10h (achou 5 unidades). Entre 10h e 11h entra uma nota fiscal (chegou mercadoria: +2 unidades). Supervisor aprova a contagem às 11h30.
- **Hoje:** O sistema vê: operador contou 5. Depois chegaram +2. Quando aprova, calcula divergência (diferença entre o que o operador viu e o que deveria estar lá). A conta fica: o saldo esperado = (saldo atual) - (entrada que chegou depois). Se a entrada foi contabilizada, o número fica correto.
- **Por que importa:** Se a contagem é velha demais (muito tempo entre contar e aprovar), outras movimentações (entrada, saída, devoluções) podem pisar na contagem e o acerto final fica errado. Tipo: você contou, mas enquanto isso a mercadoria foi saindo ou chegando.
- **Opções:** (A) Deixar como está (sistema já faz isso) → Funciona, mas se ficar muito tempo entre contar e aprovar, cresce o risco de desacerto.  ·  (B) Obrigar aprovação no mesmo dia (cutoff automático) → Reduz a janela de tempo. Contagem + aprovação em horas, não dias. Menos risco.  ·  (C) Bloquear novas movimentações enquanto contagem está em revisão → Congela a mercadoria. Mais seguro mas muito restritivo (pode atrasar picking).
- **Recomendação:** Manter como está agora, mas treinar os supervisores: aprovar no mesmo dia, quanto antes. A contagem é mais confiável se não fica pendurada.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/inventario.ts linhas 651-840; src/lib/wms/inventario-reconciliacao.ts

### D126 — Quando uma diferença é pequena o bastante, o sistema aprova sozinho ou sempre mostra pro supervisor?
- [ ] **vou fazer** · fluxo: Contagem de Estoque e Ajustes
- **Imagina assim:** Contagem de um produto caro (custa R$ 500 por unidade) que deveria ter 100 unidades em estoque. Você conta e acha 103 (diferença de +3 unidades). Seu limite de tolerância é 2%. Essa diferença de 3% está acima do limite, mas em dinheiro é só R$ 1.500.
- **Hoje:** O sistema checa dois critérios: (1) se a diferença é menor que 2% E (2) se o valor em dinheiro não passa de R$ 1.000. Se os dois forem verdadeiros, aprova sozinho e você nunca vê. Se qualquer um falhar (neste caso, 3% > 2%), manda pro supervisor revisar.
- **Por que importa:** Você precisa saber se o sistema está confiando em pequenas diferenças sozinho ou se tudo tem que passar por você. Ajuda a definir se precisa revisar tudo ou só as maiores.
- **Opções:** (A) Manter como está: sistema aprova automático se for pequeno (menos de 2%) E barato (menos de R$ 1.000) → Supervisor só vê as diferenças importantes. Mais rápido, menos trabalho. Risco: algo pequeno em dinheiro mas grande em quantidade passa silencioso.  ·  (B) Aumentar a tolerância (por exemplo, 5%) para deixar mais coisas passar automático → Menos avisos pro supervisor, mais confiança no sistema. Risco: erros maiores podem virar 'normais' sem ninguém notar.  ·  (C) Exigir aprovação de tudo, sem automático → 100% de controle, supervisor vê tudo. Mais trabalho manual, mais lento.  ·  (D) Usar apenas um critério (só % ou só valor em dinheiro, não os dois) → Mais simples de entender. Ou 'qualquer coisa acima de 2% vai', ou 'qualquer coisa acima de R$ 1.000 vai'. Menos confusão.
- **Recomendação:** Mantenha a primeira opção (2% E R$ 1.000), mas mostre claramente na tela quando algo foi aprovado automático. Assim o supervisor sabe o que o sistema aceitou sem precisar pedir permissão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:857-867, divergencias/route.ts:22-24

### D127 — Como o sistema calcula a perda em dinheiro quando um produto não tem custo registrado?
- [ ] **vou fazer** · fluxo: Contagem de Estoque e Ajustes
- **Imagina assim:** Um produto novo (SKU-TESTE) chegou apenas como amostra ou teste, nunca foi comprado de verdade. Você tem 100 unidades em estoque, faz contagem e acha 50 (perdeu 50 unidades). O sistema não sabe qual era o custo desse produto.
- **Hoje:** O sistema mostra a divergência de quantidade (-50 unidades) mas o valor em dinheiro fica R$ 0,00 (porque não consegue calcular sem saber o custo). A divergência aparece como 'pendente' (vai pro supervisor), mas sem impacto financeiro registrado.
- **Por que importa:** Você precisa saber se uma perda de 50 unidades é grave ou não. Sem o custo, fica difícil prioritizar. E depois quando o produto recebe custo 'de verdade' (em uma compra), essa divergência antiga não volta a se ajustar.
- **Opções:** (A) Registrar o custo manualmente quando contar o produto (operador digita o valor) → Mais preciso. Mas mais trabalho na contagem, e se operador errar no custo, fica tudo errado.  ·  (B) Deixar R$ 0,00 e avisar que é 'produto sem custo cadastrado', supervisor decide se é grave → Simples. Supervisor sabe que precisa checar a importância desse produto separadamente.  ·  (C) Bloquear contagem de produtos sem custo (não deixa contar até cadastrar custo) → Nenhuma confusão, mas pode atrasar contagem se houver muitos produtos de teste.
- **Recomendação:** Use a segunda opção. O sistema registra a quantidade perdida (50 unidades) e avisa claramente 'custo desconhecido'. Supervisor vê na tela e decide se é importante. Mais simples e menos bloqueios.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:779-788, 856-867

### D128 — Como funciona a parada no meio da contagem de prateleiras?
- [ ] **vou fazer** · fluxo: Aprovação de Contagem de Inventário
- **Imagina assim:** O supervisor está contando prateleiras do galpão. Meia noite já contou 40 das 100. Precisa parar pra atender algo urgente. Como fica o resto?
- **Hoje:** O sistema permite pausar na metade. Marca as que foram contadas e deixa o resto esperando. Quando volta, pode continuar do ponto que parou — mas por enquanto a função de 're-abrir pra continuar' ainda tá na fila de coisas a fazer.
- **Por que importa:** Um inventário noturno pode levar horas. Se o supervisor não conseguir terminar tudo de uma vez, é preciso pausar e voltar depois. Hoje o sistema consegue parar, mas pode estar faltando um botão ou menu pra 're-abrir aquele inventário que ficou no meio'.
- **Opções:** (A) Investigar se o botão de 're-abrir' já existe mas tá escondido → Se existe, é só treinamento. Se não existe, precisa adicionar na interface.  ·  (B) Deixar como está (pausa permanente, sempre começa novo inventário) → Mais simples, mas força refazer contagem das que já foram feitas se erro foi detectado.  ·  (C) Terminar a função de re-abertura agora (roadmap curto) → Inventários podem ser interrompidos e retomados sem perder o que foi feito. Operação mais realista.
- **Recomendação:** Recomendo a opção 3. Se seu time faz inventário de madrugada em turnos, parar e retomar no turno seguinte é essencial. Vale incluir isso nos próximos ajustes.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:707-729

### D129 — E se a mercadoria chegar enquanto estamos contando?
- [ ] **vou fazer** · fluxo: Aprovação de Contagem de Inventário
- **Imagina assim:** Terminou contagem (14:00) e esperou calcular a divergência. Achou saldo diferente. Supervisor vai aprovar em 5 minutos. Mas nesse intervalo chegou um pedido devolvido (+10 unidades daquele produto) que o sistema já registrou. Quando aprova a contagem, qual é o saldo final?
- **Hoje:** O sistema 'congela' o saldo esperado no momento que termina a contagem (14:00). Qualquer movimento que chegar depois disso — entrada, saída, devolução — não entra na conta. Exemplo real: contou 5 unidades, esperava 10 pela nota fiscal, divergência = -5. Mas entre 14:00 e 14:05 chegou entrada de 10 unidades. Sistema aprova: tira 5 (a divergência), resultado final = 15 (esperava 10 - 5 = 5). Tá errado.
- **Por que importa:** Se coisas chegam o tempo inteiro (devoluções, transferências de outro galpão, compras), esse vão de 5 minutos entre 'contar' e 'aprovar' pode criar erros que ninguém entende depois. Quanto mais tempo passar, maior o risco.
- **Opções:** (A) Sempre aprovar contagem em 1-2 minutos (operacional) → Mantém o vão pequeno. Erros são raros e pequenos. Boas práticas: contar, revisar rápido, aprovar. Inventário é tipicamente checagem final de fim de dia, deve ser rápido mesmo.  ·  (B) Sistema recalcula divergência se demorou muito (técnico) → Mais seguro, mas mais lento. Sistema avisa se chegou movimento novo e pede supervisor revisar tudo de novo.  ·  (C) Bloquear recebimentos enquanto contagem está aberta (drástico) → Sem chegadas, sem divergências. Mas operação de recebimento fica parada, pode atrasar compras e devoluções.
- **Recomendação:** Fique com a opção 1 — esse é o padrão. Treinar: contar prateleira, revisar em tempo real com supervisor, aprovar em 1-2 minutos. Se seu galpão tiver muitos movimentos naquela hora, faça inventário em horário mais calmo (madrugada de verdade, sem recebimentos).
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts:649-659

### D130 — Se o supervisor esqueceu de aprovar uma das diferenças, o sistema deixa aplicar mesmo assim?
- [ ] **vou fazer** · fluxo: Aplicação de ajustes de estoque descobertos em contagem
- **Imagina assim:** Supervisor encontrou 3 diferenças (perda de 5, perda de 10, perda de 3). Aprovou as duas primeiras, mas a terceira continua 'aguardando'. Clica em 'Aplicar' sem resolver.
- **Hoje:** O sistema não faz nenhuma validação. Aplica as duas aprovadas e deixa a terceira para trás, como se tivesse sido esquecida para sempre.
- **Por que importa:** Se alguém clica 'Aplicar' por acidente, achando que tudo está pronto, o sistema fica com contagens meio-feitas. O supervisor não recebe aviso nenhum de que faltou aprovar.
- **Opções:** (A) Sistema recusa a aplicação e diz qual diferença falta aprovar → Força o supervisor a resolver todas antes de aplicar. Mais seguro, mas pode frustrar se foi acidental.  ·  (B) Sistema aplica só as aprovadas e avisa qual ficou pendente → Mais flexível, mas fica a pendência solta no sistema e alguém pode esquecer para sempre.  ·  (C) Aplicar e automaticamente rejeitar as pendentes (assumir que esqueceu mesmo) → Limpa, mas também pode perder informação valiosa se o supervisor quer pensar mais.
- **Recomendação:** Recusar e avisar: deixa bem claro o que falta. Se supervisor quer aplicar de verdade, aprova a pendente primeiro. Se foi acidental, descobre rápido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts (aplicarSessao)

### D131 — Se a contagem foi pausada dias atrás, como o supervisor retoma para contar mais algumas prateleiras?
- [ ] **vou fazer** · fluxo: Aplicação de ajustes de estoque descobertos em contagem
- **Imagina assim:** Supervisor criou uma contagem em 01/06 (segunda), contou 3 prateleiras e parou. Hoje é 04/06 (quinta). Quer adicionar mais 2 prateleiras à mesma contagem. Sistema tem uma rotina automática que libera travamentos depois de 30 minutos.
- **Hoje:** Sistema não oferece forma de 'retomar' uma contagem antiga. Supervisor só pode cancelar a antiga e criar uma nova. A contagem antiga fica travada em 'em andamento' indefinidamente (ou em 'revisão' ou 'aplicada'), sem opção de voltar pra 'aberta'.
- **Por que importa:** Se supervisor quer completar uma contagem em várias seções (hoje conta peças, amanhã eletrônicos, depois vidro), o sistema força a refazer tudo da vez anterior. Perde tempo e risco de esquecer qual era a prateleira anterior.
- **Opções:** (A) Deixar como está: só permite criar contagem nova → Simples, mas supervisor duplica trabalho e pode perder referência da contagem antiga.  ·  (B) Adicionar botão 'Retomar contagem' que abre de novo e deixa adicionar mais prateleiras → Supervisor continua a partir de onde parou. Mais trabalho no desenvolvimento, mas muito mais prático.  ·  (C) Sistema reutiliza a contagem antiga, libera os travamentos automaticamente e deixa adicionar mais → Automático, mas se travamento vencer, outro operador poderia mexer na prateleira de novo.
- **Recomendação:** Botão 'Retomar contagem': deixa claro e seguro. Supervisor sabe que está continuando aquela contagem, não perdeu nada.
- **➡️ MINHA ESCOLHA:** 
- **Código:** inventario.ts (reentrada após TTL)

### D132 — Quando o operador conta fisicamente a prateleira e descobre que tá faltando estoque, como o sistema sabe disso?
- [ ] **vou fazer** · fluxo: Venda Manual (consulta de estoque + criação de pedido)
- **Imagina assim:** Operador chega pra contar a prateleira 1. Sistema diz: 10 unidades. Mas ele conta fisicamente: só tem 5. Faltam 5 (talvez alguém roubou, talvez errou na entrada, ninguém sabe).
- **Hoje:** Não é claro no código deste raio-X. Assume-se que existe um painel de inventário onde o operador registra 'Contei 5, sistema diz 10, divergência de -5'. O sistema deveria automaticamente baixar 5 unidades do saldo pra ficar correto.
- **Por que importa:** Se não atualizar, seu saldo fica mentindo: sistema diz que tem 10, mas tem só 5. Próxima venda que chegar, você promete 8, depois descobre que não tem. Caos.
- **Opções:** (A) Deixar como está: operador registra, ninguém faz nada → Só um log de diferença; saldo não muda (mantém a mentira)  ·  (B) Automatizar: operador digita 5, sistema baixa de 10 pra 5 sozinho → Saldo ajustado na hora; correto; mas perde rastreabilidade (por que mudou?)  ·  (C) Admin aprova: operador registra, admin aprova a mudança, sistema ajusta e loga tudo → Rastreável; seguro; mas manual
- **Recomendação:** Use a opção 3 (admin aprova). Operador registra 'Contei 5', sistema cria uma proposta de ajuste, admin vê no painel, aprova, e a mudança fica registrada no histórico com data/hora/quem aprovou. Assim você sabe exatamente quando e por que o saldo mudou.
- **➡️ MINHA ESCOLHA:** 
- **Código:** não há no código desta rota; inventário é outro domínio

### D133 — Transferência de estoque entre galpões — e se sair de um lugar mas não chegar no outro?
- [ ] **vou fazer** · fluxo: Consulta do saldo de estoque — quanto tem e onde tem
- **Imagina assim:** Você tem 100 unidades de ABC na prateleira A-01-01 do galpão CWB. Precisa mover 30 para B-02-02 em SP. Sistema faz saída em CWB (100 → 70) e entrada em SP (50 → 80). Se a entrada falhar, CWB registrou saída, mas SP não registrou entrada. 30 unidades sumiram.
- **Hoje:** Sistema registra as 2 movimentações separadamente — saída em CWB, entrada em SP. Se a segunda falha, a primeira já foi concretizada. 30 unidades viraram fantasma. Você não sabe aonde estão.
- **Por que importa:** Inventário não bate. Auditoria questiona. Você tem de contar manual pra achar os 30. Transferência é operação crítica — não pode falhar no meio.
- **Opções:** (A) Sistema agrupa as 2 movimentações como operação indivisível — ambas completam juntas ou nenhuma completa. Se falhar no meio, desfaz tudo automaticamente. → Seguro. Inventário sempre válido. Nada fica em limbo.  ·  (B) Adicionar validação após ambas — se uma falha, sistema avisa 'transferência incompleta' e você refaz manual. → Você sabe que falhou. Mas é manual e pode ser que você esqueça.  ·  (C) Deixar como está (risco de 30 unidades em limbo, inventário errado). → Instável. Só serve se você contar inventário manualmente com frequência.
- **Recomendação:** Implementar primeira opção. Transferência é operação crítica — nunca deve sair do estado 'válido'. Padrão de qualquer API séria de estoque.
- **➡️ MINHA ESCOLHA:** 
- **Código:** Procurar /api/wms/transferir ou similar

### D134 — Importar prateleiras enquanto estão contando estoque?
- [ ] **vou fazer** · fluxo: Importação em lote de prateleiras
- **Imagina assim:** Operador C bloqueou prateleira A-01 pra contar estoque manualmente (tarefa de contagem que trava aquela prateleira). Operador D quer importar um lote que inclui A-01. Avisar que está em contagem, ou deixar silencioso?
- **Hoje:** Silencioso. Sistema ignora e pula a duplicada. D não sabe que A-01 está sendo contada por C. Nenhum aviso.
- **Por que importa:** Operador pode ficar editando prateleira enquanto outro está contando, gera confusão e dados errados na contagem.
- **Opções:** (A) Avisar D: 'prateleira A-01 está em contagem agora' — mostra mensagem → D fica sabendo, pode esperar ou escolher outra prateleira  ·  (B) Bloquear D: 'não é possível tocar em A-01 enquanto estiver em contagem' — nega a importação → Seguro, mas D fica sem conseguir importar nada que tenha A-01  ·  (C) Deixar como está (silencioso) — sem mudança → Continua confuso, mas ninguém intervém
- **Recomendação:** Opção A — avisa sem bloquear, operador consegue tomar decisão
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts linha 94-98 (não checa localizacao_locks em lote)

### D135 — Quando a quantidade contada é maior que a quantidade que tem agora, o sistema deve avisar?
- [ ] **vou fazer** · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Operador contou 20 un na prateleira. Depois, 5 unidades saíram (foram vendidas ou ajustadas). Agora tem só 15
- **Hoje:** Sistema mostra '20 bipado · 15 agora', mas sem cor de alerta ou marca de 'pendente'. Fica como informação neutra
- **Por que importa:** Se a divergência foi aplicada (virou movimento no saldo) ou ainda está pendente (não foi incorporada), o dono precisa saber. Visualmente igual quer dizer contas erradas
- **Opções:** (A) Marcar divergências ainda pendentes com cor e badge — só aplicadas ficam verdes → Fica visual se falta fazer algo. Dono sabe no instante que precisa revisar  ·  (B) Mostrar data da contagem e um link pro status dela — deixa o dono investigar se quiser → Mais informação, menos guia visual  ·  (C) Deixar como está — informação sempre está lá pra quem procurar → Sem mudança. Dono pode perder divergências pendentes
- **Recomendação:** Opção 1: cor vermelha se divergência está pendente, verde se já foi aplicada. Guia visual salva tempo e erros
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/components/wms/produto-drawer.tsx:818-820

### D136 — Quando a quantidade contada é menor que a quantidade que tem agora, o que significa?
- [ ] **vou fazer** · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Operador contou 8 un. Depois uma compra de fornecedor chegou (7 un). Agora tem 15. Contagem ficou velha
- **Hoje:** Sistema mostra '8 bipado · 15 agora', sem avisar que a contagem é de antes de uma chegada de mercadoria
- **Por que importa:** Dono pode achar que faltam 7 peças (15 menos 8), quando na verdade chegou mercadoria depois. Confunde com divergência de roubo ou erro
- **Opções:** (A) Mostrar data da contagem e eventos entre a contagem e agora (chegadas, vendas) → Contexto completo. Dono vê exatamente o que aconteceu  ·  (B) Avisar em cor diferente quando contagem é 'antiga demais' (mais de X dias) → Simples, mas pode marcar falsamente se mercadoria chegou devagar  ·  (C) Deixar como está → Sem mudança, risco de confusão
- **Recomendação:** Opção 1: timeline simples mostrando data da contagem, chegadas e saídas depois. Educa o dono em tempo real
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/components/wms/produto-drawer.tsx:818-820

### D137 — Se dois operadores contam a mesma prateleira no mesmo dia, qual contagem vale?
- [ ] **vou fazer** · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Operador A contou 10 unidades. Operador B, na mesma sessão, contou 5 da mesma prateleira. Qual número aparece no histórico?
- **Hoje:** Sistema mostra a contagem mais recente — no caso, a de B (5 un). O sistema não deixa claro se é a última ou se deveria ter somado as duas
- **Por que importa:** Auditoria fica confusa. Parece que 10 un desapareceram, quando na verdade foi uma dupla contagem não combinada
- **Opções:** (A) Sempre mostrar a contagem MAIS RECENTE (a de B) — deixar claro que é a última feita → Simples. Dono sabe que vale a contagem mais fresca. Precisa descartar a de A  ·  (B) Somar as contagens quando são na mesma sessão (10 + 5 = 15 contadas) → Mais realista se os dois operadores fizeram de verdade. Mas pode contar errado se foi acaso  ·  (C) Avisar que tem múltiplas contagens no mesmo dia — obrigar revisão manual → Seguro, mas trabalhoso
- **Recomendação:** Opção 1: sempre mostrar a mais recente (a de B), mas deixar botão 'ver todas as contagens do dia' bem visível. Seguro + prático
- **➡️ MINHA ESCOLHA:** 
- **Código:** supabase/migrations/20260526_wms_produto_ultimas_contagens_3d.sql:34-45

### D138 — Quando se compara a contagem com o saldo agora, estamos comparando coisas da mesma época?
- [ ] **vou fazer** · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Contagem foi em 20 de maio às 10h (tinha 50 un). Dono vê o histórico em 21 de maio às 14h. Mercadoria chegou e saiu nesse meio tempo. Saldo agora é 30
- **Hoje:** Sistema mostra '50 bipado · 30 agora', sem mencionar que são de datas diferentes. Parece que sumiram 20 un
- **Por que importa:** Dono acha que há divergência (roubo, perda, erro), quando na verdade é só movimento normal entre contagem e agora. Gasta tempo investigando nada
- **Opções:** (A) Guardar qual era o saldo esperado no dia do bipe, comparar com o bipado, e mostrar histórico de movimentos depois → Preciso, mostra o que foi de verdade divergência vs movimento normal  ·  (B) Avisar em letras que a contagem é de X dias atrás e o saldo pode ter mudado por movimentos normais → Menos preciso, mas educa o dono  ·  (C) Deixar como está → Sem mudança, confusão garantida
- **Recomendação:** Opção 1: comparar contagem com saldo daquela mesma data, não com agora. Mostrar timeline de movimentos depois pra saldo crescer/cair
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/inventario.ts:657-720; supabase/migrations/20260526_wms_produto_ultimas_contagens_3d.sql:60

### D139 — Se contagem foi 10 dias atrás e a mercadoria quase desapareceu, como o dono sabe o que fazer?
- [ ] **vou fazer** · fluxo: Histórico das últimas contagens de um produto
- **Imagina assim:** Contagem: 100 un em 20 de maio. Hoje (30 de maio) tem 2 un. Vendeu 98 ou algo errado aconteceu?
- **Hoje:** Sistema mostra '100 bipado · 2 agora'. Sem data, sem cor, sem link pro status da contagem. Dono não sabe se aquela contagem virou movimento ou ficou pendente
- **Por que importa:** Se a contagem foi aplicada errado, o saldo agora está errado. Se foi estornada, precisa refazer. Sem context, dono fica perdido
- **Opções:** (A) Mostrar data da contagem, status dela (aplicada/pendente), e link pra sessão inteira → Dono navega e entende o que aconteceu. Mais cliques, mas informação completa  ·  (B) Avisar em cor se divergência é 'velha demais' (mais de 7 dias sem resolver) — marca em laranja ou vermelho → Visual aponta problema. Simples e rápido  ·  (C) Deixar como está → Sem mudança
- **Recomendação:** Opção 1 + Opção 2: mostrar data em destaque + cor de alerta se pendente há muito tempo. Rápido e informado
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/components/wms/produto-drawer.tsx:776-828

### D140 — A sessão de inventário está travada (sem progresso há 2 horas) — como o painel deve avisar?
- [ ] **vou fazer** · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** Operador João iniciou inventário às 10h em um iPad. O sistema registrou a sessão como 'em andamento', mas ele nunca pegou nenhuma prateleira para contar (provavelmente o iPad caiu, perdeu rede, ou ele foi chamado pra outro lugar e esqueceu). Agora é 12h. O painel mostra 'Sessões ativas: 1' mas não há progresso — nenhuma prateleira foi contada, nenhuma divergência foi registrada.
- **Hoje:** O painel mostra só uma contagem crua: 'Sessões ativas: 1, Divergências aguardando: 0'. Sem detalhes de progresso (quantas prateleiras contadas, quantas faltam, há quanto tempo nada muda).
- **Por que importa:** Supervisor não sabe se inventário está rodando ou travado. Fica uma incerteza. Pode deixar a sessão aberta por horas/dias sem ninguém perceber, atrasando o processo inteiro.
- **Opções:** (A) Painel mostrar progresso detalhado: 'Curitiba A | João | 0 de 120 prateleiras | Travado há 1h 15min' → Supervisor vê imediatamente. Clica, abre a sessão, cancela se necessário. Tudo transparente.  ·  (B) Deixar como está, mas adicionar aviso automático: se nada muda em 30 minutos, painel fica amarelo. → Menos informação, mas uma dica visual de problema. Supervisor ainda precisa investigar manualmente.  ·  (C) Rotina automática: a cada 15 minutos, se uma sessão está sem progresso, o sistema envia um alerta para o supervisor. → Proativo. Supervisor é notificado via Slack/email antes de notar no painel. Mais automático.
- **Recomendação:** Fazer 1 + 3 juntos: painel mostra progresso detalhado (vocês veem imediatamente), E rotina automática avisa se travar por >30min (não precisam ficar olhando). Custa pouco, resolve bem.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/dashboard-geral.ts:38, supabase/migrations/20260529_wms_inventario.sql:7-32

### D141 — Divergência aprovada por um supervisor desaparece do painel em 30 segundos mas reaparece ao recarregar — é um bug ou delay normal?
- [ ] **vou fazer** · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** Supervisor abre o painel em uma aba e a sessão de inventário em outra. Painel mostra 'Divergências pendentes: 3'. Supervisor aprova uma divergência (3 → 2). Mas o painel continua mostrando 3 por 30 segundos (o tempo que o painel demora pra recarregar automaticamente). Quando recarrega, vê '2' como esperado.
- **Hoje:** Painel recarrega os dados a cada 30 segundos. Quando algo muda (divergência aprovada), o painel não fica sabendo até o próximo ciclo automático (30 segundos depois).
- **Por que importa:** Pode confundir supervisor. Ele aprova, vê que continua mostrando 3, pensa 'será que não funcionou?', e aprova de novo ou recarrega manualmente. Ou fica inseguro se o sistema registrou a aprovação.
- **Opções:** (A) Usar notificações em tempo real: assim que supervisor aprova, o painel é atualizado instantaneamente em todas as abas. → Imediato. Supervisor aprova, painel muda pra 2 na hora. Nenhuma dúvida.  ·  (B) Manter 30 segundos mas fazer recarregar manualmente quando precisa (botão 'Atualizar agora'). → Operador tem controle, mas precisa clicar. Menos automático.  ·  (C) Reduzir intervalo de recarregamento pra 5 segundos em vez de 30. → Mais rápido (5s em vez de 30s), mas mais carga no banco de dados. Trocas de desempenho.
- **Recomendação:** Notificações em tempo real. Vocês usam Supabase que tem isso nativo — é questão de ligar. Zero delay, mais profissional.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/dashboard-geral.ts:40-42, supabase/migrations/20260529_wms_inventario.sql:160-165

### D142 — Lançamento manual de estoque (pra regularizar roubo/sucata) fica pendurado no painel — quem precisa fechar isso?
- [ ] **vou fazer** · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** Produto que foi roubado/danificado/sucata. Admin cria um lançamento manual pra 'regularizar' o saldo (ajuste de -5 unidades). O sistema registra, mas fica como 'pendente'. Ninguém sabe que aquilo precisa ser 'fechado' (desfeito) pra balanço reconciliar. Painel mostra 'Lançamentos manuais pendentes: 2' por semanas, mas não há processo claro pra finalizar.
- **Hoje:** Painel detecta esses lançamentos perdidos e mostra um card 'Retroativo órfão: 2', mas não tem link pra ação. Fica como um to-do moral indefinidamente.
- **Por que importa:** Balanço não reconcilia. Auditor vê que há 2 lançamentos manuais abertos e fica em dúvida: 'Isso foi proposital ou foi esquecido?'. Cria debt na contabilidade e desconfiança na auditoria.
- **Opções:** (A) Tornar visível e actionable: painel mostra lista de lançamentos (qual produto, quando, por quem, motivo), com botão 'Finalizar' pra cada um. → Dono/supervisor clica, revisa, clica 'Finalizar', sistema cria o desfazimento automaticamente. Limpo e rastreável.  ·  (B) Rotina automática: a cada 24 horas, se um lançamento > 7 dias está aberto, envia email pra supervisor + admin pedindo ação. → Proativo. Ninguém esquece. Pode ser ignorado, mas fica registrado no email.  ·  (C) Auto-finalizar após 7 dias (sem ação humana). Sistema cria o desfazimento sozinho. → Mais automático. Mas pode finalizar errado se admin esqueceu que era temporário.  ·  (D) Deixar como está. Painel mostra, responsabilidade é do dono revisar quando tiver tempo. → Zero esforço novo. Mas fica como debt indefinidamente.
- **Recomendação:** Opção 1 + 2: fazer visível + botão de ação (dono tem controle), E rotina automática de aviso se ficar > 7 dias (ninguém esquece). Leva 2-3 horas, resolve problema de auditoria permanentemente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/dashboard-geral.ts:50-85

### D143 — Quando o operador registra um ajuste de estoque, se clicar 'Registrar' duas vezes muito rápido, o sistema grava duas vezes?
- [ ] **vou fazer** · fluxo: Painel de Valor do Estoque
- **Imagina assim:** Operador acessa a tela de ajuste de estoque e clica 'Registrar ajuste' duas vezes em menos de 1 segundo (antes que a primeira chamada voltar da resposta)
- **Hoje:** O botão fica bloqueado enquanto a primeira gravação está sendo processada. Mas se for MUITO rápido (raro), pode entrar duas chamadas iguais na fila. Ambas tentam gravar o movimento — resultado: o estoque fica certo no final, mas o registro das movimentacoes de estoque mostra duas linhas idênticas em vez de uma.
- **Por que importa:** Se você faz auditoria nos movimentos, vai ver 2 registros duplicados que nunca aconteceram de verdade. Confunde quem está conferindo números. Além disso, prejudica análises de 'quem fez quantos ajustes' porque conta errado.
- **Opções:** (A) Exigir um código único por ajuste gerado no celular/navegador do operador — assim se enviarem 2 vezes, a segunda é rejeitada automaticamente como 'cópia' → Registro das movimentacoes de estoque sempre correto, sem duplicatas, mesmo em cliques duplos. Auditoria limpa.  ·  (B) Aceitar duplicatas como normal — entender que operador clicou 2 vezes propositalmente e registrar as 2 linhas no histórico (auditoria sai completa mesmo assim, porque registra tudo) → Mais simples de programar, mas o histórico fica 'sujo' com linhas duplicadas. Não é errado, apenas menos claro.
- **Recomendação:** Opção 1. Um código único por ajuste é padrão de qualidade em sistemas de estoque — garante que auditoria seja confiável. Não é caro de implementar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/ajuste/page.tsx:54-77

### D144 — A tela de 'Ajustes manuais' nos últimos 30 dias mostra apenas um número ('5 ajustes'), não lista cada um?
- [ ] **vou fazer** · fluxo: Painel de Valor do Estoque
- **Imagina assim:** Operador entra em Relatórios > Ajustes do mês. Vê apenas '5 ajustes registrados' sem tabela detalhando cada ajuste (data, motivo, quantidade, quem fez).
- **Hoje:** Sistema busca os 5 ajustes no banco, mas a tela mostra apenas a contagem — não lista linha por linha. Falta uma tabela com colunas: data, motivo, quantidade, tipo (entrada ou saída), operador.
- **Por que importa:** Operador precisa rastrear quem fez o quê e quando para controlar se ajustes foram legítimos. Sem detalhe, fica impossível auditar cada movimento manual — só consegue saber que teve 5, não sabe quais foram, quando, por quem.
- **Opções:** (A) Manter minimalista — apenas mostrar '5 ajustes registrados' para ganho visual → Tela leve, rápida. Mas sem rastreabilidade — operador quer saber mais, precisa ir num outro lugar pra achar.  ·  (B) Expandir com tabela: data, motivo, quantidade, entrada ou saída, operador que fez → Rastreabilidade completa. Operador vê tudo que precisa em um lugar. Tela um pouco mais pesada visualmente, mas muito mais útil.
- **Recomendação:** Opção 2. Tabela de detalhes é essencial em ajustes de estoque — é auditoria mínima. O sistema já busca esses dados, falta apenas mostrar na tela.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/insights/financeiro/page.tsx:94-99

### D145 — Permite peças 'meia'? (tipo, lançar 3 e meia unidade de um produto)
- [ ] **vou fazer** · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Operador lança uma compra com 3.5 peças (raro em autopecas, mas pode acontecer com produtos vendidos por quilo ou metro).
- **Hoje:** Sistema aceita qualquer número: 3, 3.5, 3.14, tudo funciona. Ninguém validou 'só inteiro' ou 'permite decimal'.
- **Por que importa:** Se a regra for 'só números inteiros' (ex: peças sempre por unidade), sistema deveria avisar erro. Se for 'pode ser qualquer número' (ex: produtos a granel), tudo bem deixar como está.
- **Opções:** (A) Exigir sempre número inteiro: 3, não 3.5. Sistema rejeita decimais. → Mais restritivo, mas claro. Se é autopecas, faz sentido.  ·  (B) Aceitar qualquer número: 3.5, 10.25, o que for. Sem validação. → Mais flexível. Pros variáveis (que pesam, não contam), funciona.
- **Recomendação:** Escolha baseado na regra do negócio: autopecas costumam ser por unidade (opção 1), mas só você sabe se tem produtos por quilo ou metro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:520


## Tema: Compras de fornecedor (29)

### D146 — Pedido de compra em validação: sistema encontrou estoque e marcou. Depois operador cancela. Deixa a marca lá?
- [ ] **vou fazer** · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Pedido de compra está em validação. Sistema rodou rotina que encontrou estoque em outro local e marcou 'saldo apareceu' (flag). Depois operador cancela o pedido.
- **Hoje:** A marca fica lá (sistema não apaga). Pedido fica 'cancelado' mas a marca diz 'saldo apareceu' — confusão visual: algo cancelado mas aparentemente com saldo?
- **Por que importa:** Operador fica confuso vendo relatório: 'Por que esse pedido cancelado está marcado como 'saldo apareceu'? Será que vem saldo ou não?'.
- **Opções:** (A) Apagar a marca quando cancela → Limpo. Relatório fica claro.  ·  (B) Deixar a marca por auditoria (saber que uma vez apareceu saldo) → Mais informação preservada. Mas confunde operador.
- **Recomendação:** Apagar a marca quando o pedido é cancelado. Se precisar saber que apareceu saldo, deixa no histórico, mas não na visão atual.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/varredura-validacao-oc.ts

### D147 — Pode um pedido criar dois pedidos de compra do mesmo produto ao mesmo tempo?
- [ ] **vou fazer** · fluxo: Marcar um produto como faltando / sem estoque
- **Imagina assim:** Dois operadores que estão organizando a separação olham pra um produto que acabou ao mesmo tempo. Os dois clicam em 'Criar compra' no mesmo instante.
- **Hoje:** O sistema tenta evitar que isso aconteça, mas só faz uma primeira verificação. Se dois pedidos chegam muito rápido um após o outro, o sistema pode criar dois pedidos de compra separados para o mesmo produto do mesmo fornecedor — cada um com metade da quantidade que precisa.
- **Por que importa:** Se for criado um pedido duplicado, você acaba pedindo mais do que deveria pro fornecedor e gasta dinheiro desnecessário.
- **Opções:** (A) Adicionar um botão que só volta ao normal depois que o sistema confirma o pedido (impede o duplo clique) → Simples e rápido de fazer. Reduz chance de duplo clique humano, mas não elimina 100% se dois operadores em máquinas diferentes clicarem.  ·  (B) Configurar o banco de dados pra permitir apenas um pedido por (fornecedor + galpão + status aguardando) — trava a segunda tentativa → Mais seguro. Sistema recusa a segunda ordem automaticamente. Precisa mudar a base de dados.  ·  (C) Adicionar as duas proteções juntas → Mais robusto. Evita na interface e garante na base de dados.
- **Recomendação:** Fazer as duas coisas. O botão desativado é fácil e rápido. Adicionar a proteção no banco é segurança extra que vale muito pra evitar sobrecompra.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/produto-esgotado/route.ts:425-465

### D148 — Se um produto volta a ter quantidade enquanto estou mandando pra outro galpão, o sistema cancela a ação?
- [ ] **vou fazer** · fluxo: Marcar um produto como faltando / sem estoque
- **Imagina assim:** Um operador abre um pedido e vê que um produto acabou em uma prateleira. Começa o processo de mandar esse pedido pra outro galpão pra separar de lá. Ao mesmo tempo, outro operador recebe mercadoria nova desse mesmo produto e coloca na prateleira original. A primeira ação continua ou para?
- **Hoje:** O sistema continua o processo de enviar pra outro galpão sem verificar de novo se o produto realmente acabou. Assume que a decisão do operador é definitiva.
- **Por que importa:** Se o produto voltou a ter estoque onde estava, enviar pra outro galpão pode ser desnecessário, aumentando o trabalho da operação e o custo de movimentação.
- **Opções:** (A) Fazer o sistema checar de novo se realmente acabou, antes de enviar pro outro galpão. Se tiver estoque, cancela a ação com aviso. → Evita movimentações desnecessárias. Mas operador precisa reabrir o pedido e escolher de novo o que fazer.  ·  (B) Deixar o sistema enviar mesmo que o produto tenha voltado (decisão do operador é final) → Rápido e respeitosa decisão da operação. Pode gerar movimentações desnecessárias se o produto realmente voltou em quantidade.
- **Recomendação:** Fazer o sistema checar de novo. Se tiver estoque, avisar o operador que o produto voltou e perguntar se ainda quer enviar pra outro galpão. Assim a operação fica mais inteligente e reduz trabalho.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/produto-esgotado/route.ts:71-247

### D149 — Se deixei um produto marcado como 'aguardando compra' há dias, posso tentar marcar de novo como esgotado?
- [ ] **vou fazer** · fluxo: Marcar um produto como faltando / sem estoque
- **Imagina assim:** No dia 1º de junho um produto esgota e você manda um pedido de compra (fica esperando receber). No dia 10, você abre o pedido de novo pra separar (talvez esqueceu que já tinha marcado antes). Tenta marcar como esgotado de novo.
- **Hoje:** O sistema deixa fazer. Se você marcar como esgotado de novo, ele cria um novo pedido de compra separado, porque não reconhece que já existe uma compra aguardando por esse produto.
- **Por que importa:** Você acaba pedindo duas vezes o mesmo produto. Quando chegarem as duas compras, você fica com estoque dobrado e gasta dinheiro desnecessário.
- **Opções:** (A) Bloquear na tela: se o produto já está aguardando compra, não deixar marcar como esgotado de novo → Evita a duplicação. Operador vê aviso de que já existe compra aberta.  ·  (B) Permitir marcar de novo, mas se já existe compra, aumentar a quantidade naquela compra (não criar uma nova) → Mais flexível. Sistema é inteligente e ajusta a quantidade automaticamente.  ·  (C) Permitir como está hoje (criar ordem separada) mas avisar com alerta bem óbvio → Rápido de implementar. Aviso depende do operador prestar atenção.
- **Recomendação:** Bloquear na tela. Se tiver compra aberta para esse produto, mostrar que já existe e não deixar criar outra. Evita duplicação de pedidos.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/produto-esgotado/route.ts:95-101

### D150 — O que fazer se uma compra de fornecedor chega durante o cancelamento?
- [ ] **vou fazer** · fluxo: Cancelamento de Separação
- **Imagina assim:** Operador cancela pedido em separação. Simultaneamente, nota fiscal de compra de fornecedor chega. Sistema faz duas coisas ao mesmo tempo: devolver estoque (cancelamento) e receber estoque novo (compra).
- **Hoje:** Quem termina por último vence. A compra pode sobrescrever o cancelamento. Estoque fica com número errado ou pedido com status confuso.
- **Por que importa:** Garantia de que os números são confiáveis. Você precisa saber se é risco real ou improvável.
- **Opções:** (A) Deixar como está → Raro acontecer; se acontecer operador vê e conserta  ·  (B) Enfileirar as operações — uma espera a outra terminar → Mais seguro; operações sequenciais, números sempre certos
- **Recomendação:** Escolha a Opção 2. Operações de estoque devem ser sequenciais, nunca paralelas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** cancelar/route.ts:212-263

### D151 — Quando um operador confirma um item em uma compra de fornecedor (OC), devemos disparar automaticamente a execução (ou esperar confirmação)?
- [ ] **vou fazer** · fluxo: Embalagem de pedidos e impressão de etiqueta
- **Imagina assim:** Uma compra chegou do fornecedor. O operador confirma o último item. O sistema automaticamente marca a compra como 'processada' e enfileira uma tarefa de lançamento de estoque.
- **Hoje:** Quando confirma o último item, o sistema: (1) marca todos os itens como recebidos, (2) marca o pedido como 'executando', (3) enfileira o lançamento de estoque em background. O operador não é avisado de nada, a tarefa roda sozinha.
- **Por que importa:** Se há bloqueadores (ex: falta autorização do gerente, ou há uma nota fiscal com problema), o estoque sai do seu controle. Operador não sabe que foi disparado. Depois fica 'onde foi meu estoque?'
- **Opções:** (A) Manter automático como agora → Rápido. Fluxo simplificado. Risco: se há exceções (precisa autorização, tem NF bloqueada), operador não sabe.  ·  (B) Avisar operador em popup: 'Compra vai ser lançada em 5 minutos, clica OK pra confirmar ou deixa em espera' → Operador tem chance de parar se algo estiver errado. Demora menos de 1 hora codificar.  ·  (C) Criar uma checklist antes de confirmar: 'Tem NF anexada? Documentação completa? Autorização do gerente?' — só depois confirma → Mais seguro. Caro de implementar. Funciona se há muitos bloqueadores.
- **Recomendação:** Opção 2: avisar com popup. Rápido de fazer, evita surpresa. Se operador ignora popup toda hora, depois migra pra opção 3.
- **➡️ MINHA ESCOLHA:** 
- **Código:** confirmar-item-embalagem/route.ts:71-304

### D152 — Um pedido pode perder a ligação com a compra do fornecedor (ficar órfão)?
- [ ] **vou fazer** · fluxo: Gestão de compras de fornecedor
- **Imagina assim:** Um item foi pedido via compra OC-123. Operador recebe a mercadoria. Durante o recebimento, o sistema atualiza a quantidade. Depois, alguém confere e vê que aquele item não está mais linkado a OC-123 — o campo ficou vazio.
- **Hoje:** Segundo o código, cada item DEVERIA estar linkado a uma OC antes de marcar como 'comprado'. Se por algum motivo aquele link (OC-123) desaparecer durante o recebimento (bug na migração do banco, ou corrupção de dados), o item fica órfão. Sistema não vai tentar cancelar a OC (porque qual OC cancelar se não tem referência?). OC fica pairando no ar, ninguém sabe que existe.
- **Por que importa:** Órfão = OC perde a rastreabilidade. Você pode pensar que aquela compra ainda tá pendente (quando na verdade o produto já chegou), e fazer uma compra duplicada. Ou auditar e perder a pista de quando a mercadoria entrou.
- **Opções:** (A) Bloquear: exigir que o link (OC-ID) seja obrigatório. Sistema recusa receber se não tiver OC. Qualquer item sem OC não pode ser marcado como 'comprado'. → Nenhum órfão. Mas se houver corrupção de dados, bloqueia recebimento — precisa reparar banco de dados antes.  ·  (B) Alertar: permitir órfãos, mas gerar aviso no painel. Alguém confere 1x por semana e limpa. → Mais flexível. Mas exige vigilância manual.  ·  (C) Deixar como está: confiar que o link não vai sumir (não vai, provavelmente). → Risco baixo. Mas se sumir (corrupção), demora pra detectar.
- **Recomendação:** Escolha opção 1 com uma salvaguarda: torne o link obrigatório no código. Se o banco ficar corrompido e aparecer um vazio, o sistema avisa com mensagem clara: 'Produto órfão — contate suporte'. Melhor prevenir do que remediar depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Gestão de compras de fornecedor")

### D153 — Quando operador clica 'Esgotado' no item, o sistema pode vinculá-lo a um novo pedido de compra com o fornecedor — mas e se operador clicar 2 vezes de acidente?
- [ ] **vou fazer** · fluxo: Validação do estoque quando precisa de compra
- **Imagina assim:** Item caderno está faltando. Operador clica 'Esgotado', sistema cria automaticamente um pedido de compra pra 3 unidades ao fornecedor. Rede lenta, operador acha que não funcionou e clica novamente (duplo clique).
- **Hoje:** Sistema verifica de novo, vê que o item já tem uma compra em andamento e reutiliza a mesma (não cria uma segunda). Parece seguro, mas não há validação de confirmação.
- **Por que importa:** Duplos pedidos de compra ao fornecedor causam chegada dupla de mercadoria (3 unidades agora, 3 unidades em meia hora) ou cancelamento confuso.
- **Opções:** (A) Exigir confirmação: 'Vai criar compra de 3 unidades. Confirma?' → Duplo clique vira 2 cliques seguidos, segundo retorna 'compra já existe'. Mais seguro.  ·  (B) Deixar como está (seguro em background) → Funciona 99% das vezes, mas sem feedback claro ao operador. Operador acha que nada aconteceu.  ·  (C) Mostrar aviso: 'Compra criada com sucesso — ID #4521' → Operador recebe confirmação visual. Sabe que não precisa clicar denovo. Duplo clique rejeita com 'compra já existe pra este fornecedor'.
- **Recomendação:** Mostre um aviso de sucesso com ID do pedido de compra. Segundo clique retorna 'compra já existe pra esta mercadoria'. Operador fica com 100% de certeza e não tenta de novo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:524-532, route.ts:677-750

### D154 — Quando operador aprova uma compra (mesmo que cubra só parte da quantidade), o que o sistema deveria fazer: aprovar automático ou pedir confirmação cada vez?
- [ ] **vou fazer** · fluxo: Criar compra automática quando um pedido chega sem estoque
- **Imagina assim:** Tem 1 peça na prateleira. Pedido precisa de 5. Sistema propõe comprar 4 faltantes. Operador clica 'Aprovar'. Naquela hora tem saldo vivo de 1 e compra pendente de 4 — total esperado 5.
- **Hoje:** Sistema aprova na mesma hora. Marca a compra como 'aguardando fornecedor'. O pedido entra em status 'esperando compra'. Nenhuma reserva é feita ainda (o estoque próprio que reserva, não a compra). Os 4 itens ficam sem marcação de 'estão sendo comprados' — o sistema não deixa claro que estão pendentes de fornecedor.
- **Por que importa:** Operador (ou gerente consultando relatório) vê pedido em 'esperando compra' mas não sabe que estão sendo comprados. Parece que está parado. Na verdade, está tudo OK — compra foi enviada — mas não tem sinal visual disso.
- **Opções:** (A) Manter aprovação automática, mas marcar os itens como 'em compra pendente' → Mesmo fluxo rápido, mas agora tem sinal visual claro: item marca status 'em compra, aguardando fornecedor'. Operador e gerente entendem o andamento.  ·  (B) Pedir confirmação a cada aprovação (vale a pena?) → Mais lento, operador clica mais. Mas talvez evite aprovar por engano. Menos comum o engano aqui.
- **Recomendação:** Manter automático, mas adicionar marcação visual. Quando compra é criada, marque os itens como 'em compra', não deixe em branco. Toma 1 hora pra adicionar, clareza total.
- **➡️ MINHA ESCOLHA:** 
- **Código:** pedidos/aprovar/route.ts:308-350

### D155 — Quando o operador cancela manualmente um item da compra, o pedido que estava esperando aquela compra deveria transicionar automaticamente ou ficar como está?
- [ ] **vou fazer** · fluxo: Criar compra automática quando um pedido chega sem estoque
- **Imagina assim:** Compra foi criada com 4 unidades do SKU 'CABO'. Pedido estava esperando essa compra. Depois operador entra na tela de exceções de compra e marca aquele item como 'cancelado' (não vem mesmo do fornecedor). Último item da compra.
- **Hoje:** Sistema deteta que nenhum item da compra está pendente (todos cancelados). Marca a compra como 'cancelada'. Mas o pedido que estava esperando continua em 'esperando compra' — nenhuma transição automática. Operador precisa lembrar de voltar ao pedido e fazer algo manualmente.
- **Por que importa:** Operador cancelou porque NÃO vai chegar o estoque. Pedido continua dormindo, esperando o que nunca vem. Pode ficar semanas nesse estado.
- **Opções:** (A) Deixar operador decidir manualmente (aprova com saldo próprio se chegou, ou cria nova compra) → Controle máximo, operador escolhe cada passo. Mas depende de operador ficar de olho.  ·  (B) Voltar pedido pra 'pendente' automático e tentar novo ciclo → Sistema reprocessa: se tem saldo agora, aprova. Se não, cria nova compra. Automático, sem intervenção.
- **Recomendação:** Opção 2. Se item foi cancelado, devolve o pedido pra 'pendente'. Sistema tenta denovo (saldo ou compra). Operador só intervém se achar necessário.
- **➡️ MINHA ESCOLHA:** 
- **Código:** compras-utils.ts:178-234 (cancelOcIfEmpty)

### D156 — Quando dois operadores mudam o SKU do mesmo item ao mesmo tempo, quem vence?
- [ ] **vou fazer** · fluxo: Trocar um produto em uma compra (antes de fazer a encomenda)
- **Imagina assim:** Operador 1 abre o pedido, vê SKU atual, digita SKU novo. Operador 2 abre o mesmo pedido (quase no mesmo tempo), vê SKU anterior dele, digita outro SKU diferente. Ambos clicam 'salvar' quase junto.
- **Hoje:** Ambas as requisições chegam e são processadas na ordem que chegam. A última requisição vence (o SKU final é o que o segundo operador digitou). Operador 1 vê a resposta mostrando o SKU que ele pediu, mas quando refetch, vê que virou outro. Confusão total — ninguém sabe qual é o SKU de verdade.
- **Por que importa:** Dois cliques simultâneos deveriam avisar que 'outra pessoa mudou na mesma hora, vê o que ela fez antes de mudar de novo'. Sem isso, um operador fica achando que salvou errado, o outro fica confuso. A mudança que deveria ter sido feita é perdida.
- **Opções:** (A) Versão com número: cada mudança incrementa um número, sistema rejeita se versão antiga → Operador 2 consegue salvar, Operador 1 recebe 'versão mudou, alguém trocou esse item'. Ele relê antes de tentar novamente. Ninguém perde.  ·  (B) Deixar como está (última mudança vence) → Continua como hoje: última requisição que vence. Se acontecer com frequência, fica caótico mas 'funciona'.
- **Recomendação:** Versão com número. Custa pouco, avisa o conflito no ato. Operador percebe e decide o que fazer em vez de descobrir depois que perdeu a mudança.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:situacao descrita

### D157 — Quando operador apertar o botão de marcar indisponível, pode-se apertar 2 vezes muito rápido. O sistema devia barrar o duplo clique?
- [ ] **vou fazer** · fluxo: Marcar uma mercadoria como indisponível (cancelamento de compra)
- **Imagina assim:** Operador marca um SKU como indisponível (fornecedor avisa que não tem mais), mas aperta o botão 2 vezes em 200 milissegundos
- **Hoje:** O sistema aceita as 2 requisições. A segunda é tecnicamente inócua (já estava marcado), mas gera 2 eventos no histórico. Fica confuso: marcou 2 vezes?
- **Por que importa:** Operador depois vê 2 linhas no histórico (foi marcado indisponível às 14:00 e de novo às 14:00 — mesma coisa). Fica dúvida: foi acidente ou foi intencional marcar 2 vezes? Deveriam ser eventos únicos e claros.
- **Opções:** (A) A. Interface desabilita o botão enquanto a requisição tá voando (cinza/travado por 1 segundo) → Operador clica uma vez, botão fica cinza, espera 1 segundo, fica normal novamente. Impossível apertar 2 vezes. Histórico tem só 1 evento.  ·  (B) B. Sistema aceita mas detecta que já tava indisponível e ignora silenciosamente (sem duplicar evento) → Mesmo que operador clique 2 vezes, o sistema grava só 1 evento. Histórico fica limpo.  ·  (C) C. Deixar como está (aceita duplo clique, gera 2 eventos) → Segue como agora — duplo clique = 2 linhas no histórico. Mais confuso e menos profissional.
- **Recomendação:** Opção A. Interface travada é mais rápido de implementar e o padrão em todo WMS (operador clica, sente o feedback de que foi). Opção B é mais robusta mas mais lenta.
- **➡️ MINHA ESCOLHA:** 
- **Código:** compras/page.tsx:406-422

### D158 — Se operador marca um SKU como indisponível por engano, tem forma de voltar atrás?
- [ ] **vou fazer** · fluxo: Marcar uma mercadoria como indisponível (cancelamento de compra)
- **Imagina assim:** Operador marca SKU ABC-123 como indisponível. 5 minutos depois, fornecedor liga dizendo que achou a quantidade, ou foi marcado errado.
- **Hoje:** Hoje não tem botão/opção de reverter. Operador teria que avisar um dev pra ir direto no banco de dados ou criar um novo SKU equivalente.
- **Por que importa:** Operador precisa poder corrigir erros rápido, sem chamar desenvolvimento. Se não pode reverter, precisa de outro fluxo (devolver, criar nova compra), que é mais lento e trabalhoso. Produto fica parado.
- **Opções:** (A) A. Criar um botão 'Reativar' que volta o SKU de indisponível pra ativo → Operador clica, SKU volta ao normal. Se ele tinha sido associado a uma compra, volta a associação também. Rápido e direto.  ·  (B) B. Não reverter direto — operador usa fluxo de 'Devolver' pra criar uma nova compra do SKU → Mais burocrático. Operador faz uma devolução (que vai gerar um estorno, trâmites), depois cria nova compra. Demora mais, gera mais linhas no histórico.  ·  (C) C. Deixar como está — uma vez indisponível, é indisponível forever (requer ação manual de dev) → Operador fica dependente. Demora mais, SKU fica parado, pode perder venda.
- **Recomendação:** Opção A. Se erro é comum, botão de reverter salva tempo. Se raro, custa pouco implementar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/

### D159 — Um SKU que não está vinculado a nenhuma compra (compra normal de venda) — devia ser possível marcar como indisponível?
- [ ] **vou fazer** · fluxo: Marcar uma mercadoria como indisponível (cancelamento de compra)
- **Imagina assim:** Operador tenta marcar como indisponível um SKU que é venda normal (não veio de compra de fornecedor). O sistema deixa fazer.
- **Hoje:** Não há validação — o sistema deixa marcar. SKU fica com status incomum, mas o pedido continua normal (não cancela, porque pedido tem outros itens que são vendas normais). SKU fica marcado de forma estranha e confusa.
- **Por que importa:** Se SKU é venda normal (não é compra), 'indisponível' não faz sentido — o botão não deveria aparecer, ou o sistema devia avisar que não funciona aqui. Fica confusão: marcou mas nada aconteceu.
- **Opções:** (A) A. Interface esconde o botão de 'indisponível' em SKUs de venda normal (mostra só em SKUs de compra) → Operador nunca vê a opção se não é compra. Evita erro.  ·  (B) B. Sistema bloqueia a ação no sistema por trás com mensagem clara: 'Só pode marcar indisponível em itens de compra' → Se alguém conseguir apertar (por bug na interface ou acesso direto), sistema rejeita com aviso.  ·  (C) C. Deixar como está (sem validação, marcação funciona mesmo em venda normal) → Continua confuso — operador marca mas nada acontece visível, pode pensar que buguou.
- **Recomendação:** Opção A + B. Esconder na interface (A) e proteger no sistema por trás também (B) é o padrão de bom design.
- **➡️ MINHA ESCOLHA:** 
- **Código:** indisponivel/route.ts:30-35

### D160 — Dois cliques rápidos no botão 'Confirmar cancelamento' — sistema gera erro na segunda vez?
- [ ] **vou fazer** · fluxo: Cancelamento de item de compra de fornecedor
- **Imagina assim:** Operador clica 'Confirmar cancelamento' duas vezes em sequência rápida (conexão lenta, ou clicou sem querer duas vezes).
- **Hoje:** Primeira clicada funciona e marca como cancelado. Segunda clicada gera erro (conflito), porque já não está mais em cancelamento pendente. Operador vê mensagem de erro na tela.
- **Por que importa:** Se sistema gera erro em uma operação que já foi feita, operador não sabe se funcionou ou não. Cria dúvida se cancelamento entrou de verdade.
- **Opções:** (A) Manter como está — segunda tentativa gera erro → Operador vê erro e fica inseguro, pode clicar de novo ou tentar de outra forma.  ·  (B) Segunda tentativa retorna sucesso → Operador clica quantas vezes quiser, sempre retorna 'ok'. Mais amigável, menos dúvida.
- **Recomendação:** Fazer a segunda tentativa retornar sucesso. Não é um erro se o sistema já fez o que foi pedido — é só redundância. Operador não precisa ver mensagem vermelha.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/itens/[itemId]/cancelamento/confirmar/route.ts linha 40-44

### D161 — Quando um pedido tem itens de várias compras diferentes, como coordenar a devolução?
- [ ] **vou fazer** · fluxo: Devolver um item de compra de fornecedor
- **Imagina assim:** Um pedido de cliente tem 5 itens. 3 vieram da compra A, 2 vieram da compra B. Operador devolve 1 da compra A.
- **Hoje:** Cada devolução é processada de forma isolada. Compra A é revisada, compra B não é tocada. Não há coordenação entre elas.
- **Por que importa:** Você precisa saber se as compras estão consistentes entre si. Se devolver de A, você sabe se precisa fazer algo em B? Precisa comunicar os dois fornecedores?
- **Opções:** (A) Deixar cada compra independente: devolve de A, só A é revisada, B fica como está → Mais simples. Cada compra tem seu próprio ciclo. Mas você tem que lembrar que existem as duas.  ·  (B) Ao devolver de A, revisar também o pedido inteiro: quais compras ainda estão ativas? B deve virar urgente? → Mais trabalhoso. Mas mais coordenado. Você vê o quadro completo.  ·  (C) Marcar o pedido como 'precisa replanejamento', bloqueando até operador revisar todas as compras → Forçado, mas seguro. Ninguém passa pela devolução sem revisar o todo.
- **Recomendação:** Opção 3: marcar pedido pra replanejamento. Força uma revisão completa, reduz surpresas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/compras-utils.ts:178-234

### D162 — Qual é o tempo de entrega típico do fornecedor? O sistema já sabe disso quando faz a análise?
- [ ] **vou fazer** · fluxo: Painel de cobertura de estoque
- **Imagina assim:** Produto X foi cadastrado sem a informação de 'qual é o fornecedor principal' ou 'quantos dias o fornecedor demora pra entregar'.
- **Hoje:** Sistema não consegue avaliar se o estoque vai durar tempo suficiente (não sabe o prazo). Deixa marcado como 'tudo bem' sem checar contra o tempo de entrega. Operador nunca recebe aviso de risco.
- **Por que importa:** Se não sabe quantos dias o fornecedor demora, não consegue avisar quando vai faltar estoque. Pode deixar desabastecido.
- **Opções:** (A) Exigir que todo produto tenha um 'fornecedor principal' com 'tempo de entrega' cadastrado antes de usar no sistema. → Sistema avisa correto quando vai vencer o estoque. Mais trabalho administrativo no início.  ·  (B) Deixar opcional. Quando não tem fornecedor, o sistema marca como 'ok' (sem risco avaliável) e ignora análise de prazo. → Simples, mas sem proteção. Operador responsável manualmente.
- **Recomendação:** Deixar opcional. Se o produto crítico é mantido manualmente pelo operador ou é compra spot, não precisa de fornecedor fixo. Se precisa aviso automático, daí sim cadastra o fornecedor principal.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Painel de cobertura de estoque")

### D163 — Quando o tempo de entrega de um fornecedor muda, quanto tempo até o sistema refletir essa mudança?
- [ ] **vou fazer** · fluxo: Atualização de cobertura de estoque
- **Imagina assim:** Produto Z com fornecedor preferencial: hoje o tempo de entrega é 7 dias, estoque cobre 18 dias. Admin atualiza o fornecedor e muda o tempo para 21 dias (mais lento agora). Análise de cobertura deveria mostrar risco (18 dias < 21 dias).
- **Hoje:** O sistema atualiza a informação do fornecedor imediatamente no banco de dados. Mas a análise de cobertura só refaz os cálculos de 1 em 1 minuto (rotina automática do sistema). Nessa janela de tempo, o gerente vê a informação antiga.
- **Por que importa:** Se o gerente quer saber agora se tem risco de desabastecimento após a mudança do fornecedor, fica esperando até 1 minuto. Para a maioria dos casos, 1 minuto é aceitável. Mas se a urgência é imediatamente, gera frustração.
- **Opções:** (A) Deixar como está: atualização a cada 1 minuto. Admin muda fornecedor e aguarda o ciclo seguinte pra ver reflexo no dashboard. → Funciona bem para ajustes não-urgentes. Minimiza carga no sistema. Latência aceitável: <= 1 minuto.  ·  (B) Recalcular imediatamente após editar fornecedor: quando admin salva uma mudança, o sistema roda a análise de cobertura na hora. → Feedback imediato. Admin vê mudança no dashboard em segundos. Custa um pouco mais de processamento, mas é pontual.
- **Recomendação:** Escolha opção 1 (deixar a cada 1 minuto). 1 minuto não é problema para reposição (que é decisão de horas/dias). Se no futuro o gerente disser 'preciso ver agora', a opção 2 fica pra depois. Por enquanto, simplicidade vence.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260520f_mviews.sql:55-59

### D164 — Se um produto tem vários fornecedores, qual tempo de entrega o sistema usa para calcular cobertura?
- [ ] **vou fazer** · fluxo: Atualização de cobertura de estoque
- **Imagina assim:** Produto X tem 2 fornecedores mapeados: A (preferencial, 10 dias de entrega) e B (backup, tempo não preenchido). Sistema consulta a análise de cobertura.
- **Hoje:** O sistema pega o fornecedor marcado como 'preferencial' (A, com 10 dias) e usa esse tempo. Se acaso o banco retornar múltiplas linhas, o SQL usa DISTINCT para garantir 1 resultado, e pega o primeiro. Se nenhum tempo foi preenchido, status vira 'risco'.
- **Por que importa:** Múltiplos fornecedores podem criar confusão: qual é o real lead time do produto? Qual é o backup? Se não houver uma regra clara, gerente fica na dúvida se a análise de cobertura é confiável.
- **Opções:** (A) Forçar 1 fornecedor preferencial por produto: cada produto tem exatamente um fornecedor principal, outros são opcionais/backups (sem afetar análise automática). → Claro e simples. Análise de cobertura usa sempre o mesmo time de entrega. Sem ambiguidade.  ·  (B) Usar o fornecedor com menor tempo de entrega (mais otimista). → Maximiza a chance de repor rápido. Mas pode ser falso otimismo se fornecedor A fica sem estoque.  ·  (C) Usar o fornecedor com maior tempo de entrega (mais conservador). → Mais seguro contra atrasos. Mas pode gerar excesso de estoque se outros fornecedores forem mais rápidos.
- **Recomendação:** Escolha opção 1 (forçar 1 preferencial). Simplicidade e clareza. Se gerente quer testar outro fornecedor, alterna o 'preferencial' pra aquele e roda uma análise comparativa. Evita lógicas complexas que ninguém entende depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260520f_mviews.sql:55-59

### D165 — Um item foi liberado da compra de fornecedor, mas outro do mesmo pedido ficou preso. Pedido fica split ou completo?
- [ ] **vou fazer** · fluxo: Reconciliação de pedidos quando entra estoque novo
- **Imagina assim:** Pedido PED789 com 2 itens, ambos precisam comprar. Item 1 (SKU-B, 10 un, pedido 1h atrás): fornecedor tem saldo livre. Item 2 (SKU-C, 5 un, pedido agora): ainda não tem saldo. Sistema usa fila (FIFO): primeiro pedido tem prioridade. Saldo da empresa: 12 un. Item 1 leva 10 (fica 2). Item 2 precisa de 5 (só tem 2). Fica bloqueado.
- **Hoje:** Sistema libera Item 1 automaticamente (saldo coube), cria movimento interno, desvincula da compra aquele item. Item 2 não foi liberado (saldo insuficiente), fica como 'compra pendente'. Mas o pedido inteiro fica marcado como 'compra pendente' — então o separador não vê qual item foi liberado.
- **Por que importa:** Você tem 1 item pronto pra separar (Item 1) mas o sistema mostra o pedido inteiro como bloqueado. Operador não sabe que pode começar Item 1. Pensa que pedido inteiro está esperando fornecedor.
- **Opções:** (A) Separar o pedido inteiro só depois que todos os itens chegarem (compra 100% fechado) → Você espera mais, mas pedido sai completo. Cliente não recebe meia compra. Mais seguro, mas mais lento — comprador fica esperando Item 1 enquanto Item 2 demora.  ·  (B) Liberar Item 1 imediatamente, deixar Item 2 bloqueado, permitir que operador veja que item 1 está pronto → Operador separa Item 1 já, cliente recebe meia compra rápido. Item 2 vem depois (segunda embalagem). Mais ágil, mas cliente recebe 2 pacotes diferentes — pode confundir.  ·  (C) Rejeitar Item 1 também enquanto Item 2 não tiver saldo (tudo junto ou nada) → Ambos ficam bloqueados até fornecedor ter os 15. Cliente recebe tudo junto. Mais simples, menos bifurcação, mas espera mais.
- **Recomendação:** Escolha a opção 2: Libere Item 1 já, deixe Item 2 para depois. Mas a UI precisa mostrar claramente ao operador que item 1 (SKU-B) está pronto e item 2 (SKU-C) ainda não — não deixa como 'pedido bloqueado'. Assim você ganha tempo e cliente sabe que entrega vem em 2 lotes.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reconciliador-oc.ts:83-215, 271

### D166 — Como lidar quando fornecedor Tiny fica duplicado (2 contas, mesmo ID)?
- [ ] **vou fazer** · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Tiny retorna 2 fornecedores diferentes (A e B) mas os dois têm mesmo ID (999). Quando segunda entrada chega, sobrescreve a primeira.
- **Hoje:** Sistema usa a técnica de gravar ou atualizar — se fornecedor com ID 999 existe, atualiza; se não existe, cria. Segunda entrada (B) atualiza a primeira (A). Só sobrevive a última. Preço de fornecedor vem sempre da mesma fonte (Tiny), então ambos custam igual mesmo sendo contas diferentes.
- **Por que importa:** Você perde informação de fornecedor. Se A e B são de verdade fornecedores diferentes, você precisa saber dos dois (talvez A mais barato, B mais rápido). Limpar um ao atualizar é perigoso.
- **Opções:** (A) Deixar atualizar (último vence) → Só vê 1 fornecedor. Se alternava entre A e B, fica perdido qual é atual.  ·  (B) Rejeitar duplicado — bloquear se ID 999 já existe, não deixa segunda entrada → Evita perda de dados. Operador precisa resolver no Tiny qual é verdade antes de sincronizar.  ·  (C) Guardar os 2 mas marcar um como 'backup' ou 'antigo' → Mantém histórico. Operador vê ambos mas sabe qual é ativo.
- **Recomendação:** Rejeitar duplicado. Força você a ter ID único de verdade no Tiny.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

### D167 — Quando o sistema compra de um fornecedor, qual ele escolhe se o produto tem 5 fornecedores?
- [ ] **vou fazer** · fluxo: Cadastro de fornecedores
- **Imagina assim:** Você tem um motor (id=MOT-P1) fornecido por 5 empresas: Tiger, Lion, ACA, Premium, Genérico. Você marcou Tiger como 'preferencial'. Quando estoque acaba, o sistema abre compra automática — abre pra Tiger (o preferencial) ou pra um qualquer?
- **Hoje:** Tem uma função que sabe qual é o fornecedor preferencial (está no código), mas não confirmei se essa função é realmente usada em nenhum lugar. Pode ser que o sistema não use essa informação — só fica guardada, tipo um post-it que ninguém lê.
- **Por que importa:** Se preferencial não é usado, o sistema pode comprar do fornecedor mais caro ou mais lento sem perceber. Você pensa que vai comprar do Tiger barato, mas o sistema escolhe Genérico caro. Desperdiça dinheiro.
- **Opções:** (A) Ativar o fornecedor preferencial no sistema de compra → Quando falta estoque, o sistema abre compra automática do fornecedor que você marcou como melhor. Custo controlado, prazos previsíveis.  ·  (B) Deixar como está (só informação guardada) → Continua como agora. Admin tira à mão quando compra, escolhendo qual fornecedor chamar. Sem automação.
- **Recomendação:** Ative o fornecedor preferencial nas compras automáticas. Se Tiger é mais barato e entrega rápido, deixe o sistema chamar ele. Economiza decisão do dia a dia.
- **➡️ MINHA ESCOLHA:** 
- **Código:** fornecedores.ts:277-294

### D168 — Se um usuário clica 2x rapidinho no botão 'Marcar como preferencial', o sistema deveria tentar processar os 2 cliques ou bloquear o segundo?
- [ ] **vou fazer** · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Admin clica 2x em 'Marcar F2 como preferencial' do produto P123.
- **Hoje:** O sistema processa os 2 cliques como se fossem 2 requisições diferentes. O navegador não bloqueia porque o botão não foi desabilitado, e o servidor não tem proteção contra duplicação. Os 2 chegam quase simultâneos.
- **Por que importa:** Duplo clique é comum: dedo involuntário, rede lenta. Seu sistema deveria ser robusto contra isso. Se deixar passar, cada clique faz leitura e escrita desnecessárias no banco. Se houver duas ações no mesmo instante pisando uma na outra, pode deixar dados inconsistentes.
- **Opções:** (A) Desabilitar botão no navegador enquanto processa → Usuário não consegue clicar 2x. Simples de implementar. Mas se a rede está lenta, usuário acha que botão congelou.  ·  (B) Aceitar os 2 cliques, mas servidor processa sem duplicação → Botão fica responsivo, mas sistema aguenta o dobro de carga. Mais robusto se rede é instável.  ·  (C) Deixar como está: confia que usuário não clica 2x → Mais simples de programar. Risco: em produção, alguém vai clicar 2x e pode quebrar.
- **Recomendação:** Desabilitar botão enquanto processa. É o padrão. Alivia pressão no servidor e deixa claro pro usuário que tá processando.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/produto-fornecedores/[id]/route.ts:66-81

### D169 — Se há pedidos pendentes (esperando aprovação) que dependem de um fornecedor, você quer bloquear a exclusão daquele fornecedor ou deixar remover mesmo assim?
- [ ] **vou fazer** · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Fornecedor F5 está vinculado ao produto P456. Há 2 pedidos em validação esperando que F5 seja aprovado. Admin tenta deletar F5.
- **Hoje:** O sistema deixa deletar (marca inativo). Os 2 pedidos continuam lá, mas agora o fornecedor desapareceu. Se alguém tentar aprovar os pedidos depois, o sistema não acha mais F5. Confusão.
- **Por que importa:** Se tem pedido pendente, aquele fornecedor é crítico pra negócio. Deletar sem avisar é errado. Você quer saber: 'ei, tem pedido lá que precisa desse fornecedor'.
- **Opções:** (A) Bloquear delete: avisar 'não posso deletar, tem 2 pedidos esperando aprovação' → Força você a resolver os pedidos primeiro. Mais seguro. Deixa explícito o risco.  ·  (B) Deletar e avisar: remover mas mostrar uma lista de pedidos que ficaram órfãos → Mais flexível. Você deleta e depois resolve o estrago. Risco: você esquece dos pedidos órfãos.  ·  (C) Deixar deletar silenciosamente → Muito flexível mas muito perigoso. Pedidos viram fantasmas.
- **Recomendação:** Bloquear delete. Força a fazer certo: resolve pedido antes de desativar fornecedor. Evita pedidos órfãos.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/produto-fornecedores/[id]/route.ts:106

### D170 — Um fornecedor pode ter quantidade mínima de pedido igual a zero (nenhum mínimo)?
- [ ] **vou fazer** · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Você está criando vínculo com fornecedor F20 e seta 'quantidade mínima por pedido' como 0 (zero).
- **Hoje:** O sistema aceita e salva no banco. Não há validação contra zero. Se depois você pede 1 unidade, o sistema permite (porque 1 >= 0).
- **Por que importa:** Alguns fornecedores são muito flexíveis e aceitam qualquer quantidade. Outros exigem mínimo de 10, 50, 100. Você quer saber: o zero é intenção ou é acidente?
- **Opções:** (A) Permitir zero: alguns fornecedores são tão flexíveis que aceitam qualquer quantidade → Mais liberdade. Zero significa 'sem mínimo'. Você escolhe quando pedir.  ·  (B) Forçar mínimo 1: todo fornecedor exige pelo menos 1 unidade → Mais realista. Ninguém pede zero. Evita pedidos vazios por acidente.  ·  (C) Avisar quando é zero: aceitar mas mostrar atenção 'cuidado, sem mínimo configurado' → Flexível mas com aviso. Você escolhe, mas consciente.
- **Recomendação:** Forçar mínimo 1. Mais seguro. Se um fornecedor realmente aceita qualquer coisa, configure 1 mesmo (não muda nada).
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/produto-fornecedores/[id]/route.ts:35-36

### D171 — Quando você deixa o 'código do produto no fornecedor' em branco, deveria salvar como vazio em branco ou como vazio de verdade?
- [ ] **vou fazer** · fluxo: Cadastro de Fornecedores e Seus Vínculos com Produtos
- **Imagina assim:** Você edita o vínculo F20 e limpa o código (deixa em branco). Quer enviar para o sistema.
- **Hoje:** O sistema aceita tanto branco quanto vazio. No banco, fica registrado exatamente como você mandou. Dois registros podem estar vazios de formas diferentes, um com espaço, outro de verdade vazio.
- **Por que importa:** Se seu código de integração depois procura por 'qual é o código desse fornecedor', pode achar um vazio, outro de verdade vazio, e ficar confuso. Precisa normalizar.
- **Opções:** (A) Normalizar: sempre converter branco para vazio antes de salvar → Limpo. Dentro do sistema, sempre vazio significa 'não tem código'. Sem ambiguidade.  ·  (B) Aceitar ambos: permitir branco e vazio, mas padronizar em consultas → Mais flexível na entrada, mas código que consulta tem que tratar os dois casos.  ·  (C) Deixar como está: branco é branco, vazio é vazio → Simples de programar. Risco: seu código de integração fica confuso.
- **Recomendação:** Normalizar para vazio. Simples, limpo, sem surpresas depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/produto-fornecedores/[id]/route.ts:41-42

### D172 — Se o fornecedor principal de um produto não está definido no sistema, como deveria aparecer no alerta de cobertura?
- [ ] **vou fazer** · fluxo: Visão de Saúde do Estoque
- **Imagina assim:** Um parafuso que leva 30 dias pra chegar do fornecedor tem só 25 dias de estoque. Deveria acender um alerta vermelho: 'Cuidado, estoque não dura até a compra chegar'. Mas se ninguém configurou qual é o fornecedor preferencial desse parafuso no sistema, o alerta não dispara — fica 'OK' por acaso.
- **Hoje:** O sistema procura o fornecedor preferencial desse produto. Se achar, pega o tempo de espera da compra e compara: IF dias_cobertura < tempo_espera THEN alerta. Se não achar fornecedor, o tempo de espera fica em branco e a comparação não roda — fica 'OK'.
- **Por que importa:** Operador vê 'OK' e não faz reposição. Produto sai antes da compra chegar. Vira falta. Tudo porque um cadastro incompleto no sistema.
- **Opções:** (A) Na tela, mostrar aviso diferente: 'Atenção: fornecedor preferencial não configurado. Cobertura pode estar errada' — sinalizar que é config incompleta, não que está OK → Operador vê flag de 'incompletude' e toma cuidado manual. Simples, visual  ·  (B) Usar tempo de espera padrão (por categoria ou padrão geral): se fornecedor preferencial não tem tempo de espera, usa um fallback. Ex: 'se não tem dado, assume 14 dias' → Alerta vai funcionar mesmo sem fornecedor preferencial configurado. Precisa definir um padrão bom  ·  (C) Marcar status como 'indeterminado' (não é OK, não é erro): 'Status: ?'. Operador sabe que precisa verificar manualmente → Claro que há incerteza. Operador fica atento. Mas gera mais trabalho manual
- **Recomendação:** Opção 1 (aviso de config incompleta) é rápida. Opção 2 (tempo de espera padrão) é melhor no longo prazo — menos surpresas. Combine: aviso visual + fallback.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260605_wms_excecoes_dashboards.sql linhas 53-78

### D173 — Aceitar item de fornecedor que estava indisponível e depois voltou?
- [ ] **vou fazer** · fluxo: Produtividade e ranking dos operadores
- **Imagina assim:** Compra chegava: item estava 'indisponível' (falta no fornecedor). Operador marcou quantidade bipada. 2 horas depois, item volta pra 'aguardando fornecedor'.
- **Hoje:** Sistema conta o operador nos dois momentos, como se tivesse feito separação 2 vezes.
- **Por que importa:** Operador que separou um item indisponível não deveria contar pra produtividade. Depois, se item volta e é separado de verdade, vai contar em duplicata (2 vezes).
- **Opções:** (A) Excluir itens 'indisponível' da contagem de separação: operador trabalha, mas não recebe crédito até o item estar de verdade disponível. → Ranking só conta separações reais.  ·  (B) Deixar contar: operador separou quando pôde, merecia crédito. → Reconhece esforço. Mas pode contar 2x se item reaparece.
- **Recomendação:** Exclua itens indisponíveis da contagem (como já faz pra embalagem). Só conta quando item está de fato disponível.
- **➡️ MINHA ESCOLHA:** 
- **Código:** migration 20260515 linhas 176-180

### D174 — Nota que você lançou vai nunca ser usada (NF cancelada, compra anulada)? Tem que limpar ou pode ficar pra sempre?
- [ ] **vou fazer** · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Operador lançou compra de 50 peças em emergência (2 de junho). Depois descobre que a NF foi cancelada no Tiny. Compra não vai mais chegar. Operador pode esquecer de 'desfazer' aquele lançamento.
- **Hoje:** Lista de notas pendentes fica mostrando aquela compra indefinidamente. Não tem opção de 'cancelar' ou 'descartá-la'. Fica acumulando.
- **Por que importa:** Se operador não limpar, depois de 3 meses a lista tem 30 notas, não sabe quais são de verdade. Confusão total.
- **Opções:** (A) Oferecer botão 'Cancelar nota' que desfaz tudo (tira as peças que você colocou). → Limpeza manual, operador controla.  ·  (B) Notas com mais de 30 dias não acertadas recebem alerta: 'essa está há 1 mês, quer cancelar?' → Sistema avisa, operador decide.  ·  (C) Listar 'saber o status real': integrar com Tiny, ver se a NF de verdade foi cancelada, remover automaticamente. → Sem trabalho manual, mas precisa de integração extra.
- **Recomendação:** Opção 1 + alerta (1+2) — simples, operador controla mas com aviso.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:559-591


## Tema: Cadastros (produtos, prateleiras, fornecedores) (25)

### D175 — Posso aprovar um pedido se o mapeamento entre seu código de produto e o código do sistema sumiu?
- [ ] **vou fazer** · fluxo: Aprovação de Pedidos e Compras
- **Imagina assim:** #999: pedido vem da loja com um código de produto (111). Seu operador aprova. Na hora de apartá-lo, o sistema procura o mapeamento (qual prateleira tem esse produto) e não acha.
- **Hoje:** A aprovação falha. O pedido volta pra 'pendente' pra tentar novamente depois.
- **Por que importa:** O mapeamento deve estar pronto antes de alguém aprovar qualquer coisa. Se não tiver, significa que o produto não foi cadastrado direito — ou nunca entrou no seu sistema, ou foi deletado por acidente.
- **Opções:** (A) Impedir que o mapeamento seja deletado se houver pedidos pendentes usando esse produto. → Evita surpresa. Mas trava o cadastro.  ·  (B) Validar o mapeamento já na hora que o pedido chega (não na aprovação), e avisar logo se tiver faltando. → Problema surfaced early. Dá tempo de corrigir antes de chegar na retaguarda.  ·  (C) Manter um mapeamento 'coringa' (fallback) pra produtos que não acham seu par. → Nunca falha. Mas vai tudo pro mesmo lugar, precisa de triagem extra depois.
- **Recomendação:** Use a opção 2. Na hora que o pedido chega da loja (via aviso), valide todos os produtos e avisos se falta mapeamento. Assim, a retaguarda já sabe que tem produto estranho antes de alguém tentar separar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/aprovar/route.ts:520-524 + 565-570

### D176 — O que fazer quando um produto não está configurado no mapeamento?
- [ ] **vou fazer** · fluxo: Recebimento de Compra de Fornecedor
- **Imagina assim:** A compra vem do fornecedor X com um SKU que nunca foi recebido nessa empresa. O produto existe no cadastro, mas a empresa Y não está ligada a esse produto.
- **Hoje:** O sistema pula o item silenciosamente, apenas registra um aviso interno. O operador vê 'recebimento bem-sucedido' mesmo que alguns itens foram ignorados.
- **Por que importa:** O operador não sabe qual item foi pulado e pode deixar mercadoria na doca pendurada, ou você descobre só depois quando faz contagem.
- **Opções:** (A) Bloquear antes de começar: verificar todos os produtos antes de chamar receber → Operador vê erro na tela, antes de tentar, e chama o suporte pra configurar o produto  ·  (B) Contar e exibir: gravar quais itens falharam e mostrar na tela 'itens 3, 5 e 7 foram ignorados' → Operador vê na hora que faltam 3 itens e pode chamar suporte ou ajustar
- **Recomendação:** Bloquear antes de começar. Mostrar uma lista de quais produtos não estão configurados e deixar o operador chamar você pra resolver antes de continuar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** receber-oc.ts:118-130

### D177 — Como fazer quando a prateleira de embalagem não existe?
- [ ] **vou fazer** · fluxo: Recebimento de Compra de Fornecedor
- **Imagina assim:** O galpão está configurado, mas alguém deletou a prateleira tipo 'embalagem' por acidente. Llega uma compra que normalmente mandaria alguns itens pro cross-dock (embalagem).
- **Hoje:** O sistema detecta que não tem prateleira de embalagem e manda tudo pro armazenamento normal, sem alertar ninguém.
- **Por que importa:** Você continua recebendo, mas o galpão está quebrado e ninguém sabe. Nos próximos dias, vira caos porque o fluxo de embalagem é diferente do armazenamento normal.
- **Opções:** (A) Deixar como está (fallback para armazenamento): tudo vai pra guardar normal → Continua funcionando, mas o galpão está mal configurado e ninguém sabe  ·  (B) Alertar no dashboard: colocar um aviso 'galpão faltam prateleiras críticas' → Você vê que há um problema e pode recadastrar a prateleira antes de virar caos
- **Recomendação:** Alertar no dashboard do operador que a prateleira está faltando. Deixar receber mesmo assim (não bloqueia), mas chamar atenção pra o problema.
- **➡️ MINHA ESCOLHA:** 
- **Código:** crossdock-detector.ts:58-76

### D178 — Qual é a lista de 'motivos' válidos quando alguém faz um ajuste manual (erro, achado, avaria)?
- [ ] **vou fazer** · fluxo: Desfazer um ajuste de estoque
- **Imagina assim:** Operador faz um ajuste: 'Achei 3 unidades atrás da prateleira'. O sistema pede motivo_categoria (dropdown). Se não escolher, não deixa gravar. Se alguém pula a tela e chama a comunicação entre sistemas direto sem passar motivo, o movimento fica sem classificação — aparece em branco no relatório.
- **Hoje:** Tela força escolher uma categoria (validação na tela). Se alguém chamar a comunicação sem categoria, sistema aceita vazio no banco — movimento grava sem classificação.
- **Por que importa:** Você quer saber depois: 'Quantas unidades a gente perdeu (avaria) vs. achadas vs. erro de digitação?' Sem categoria, não consegue separar. Auditoria fica sem contexto.
- **Opções:** (A) Deixar como está: tela obriga, mas comunicação aceita vazio. Se alguém chamar comunicação sem categoria, fica em branco. → Flexível (dados legados podem ser vazios). Risco: usuário da comunicação pula validação e perde contexto no relatório.  ·  (B) Forçar no banco de dados: coluna NÃO pode ser vazia. Quem tentar gravar sem categoria, sistema rejeita. → Impossível pular a validação. Todos os ajustes têm categoria. Mas precisa resolver dados antigos (quem tem vazio agora?).  ·  (C) Aviso na tela: 'Categoria é obrigatória. Valores aceitos: Erro / Avaria / Achado / Outro'. Se deixar em branco, mostra erro bem visual. → Simples. Tela já faz isso — comunicação ainda aceita vazio. Se quiser impedir 100%, força no banco também.
- **Recomendação:** Opção 2. Force no banco. Impossível de furar. Quer deixar histórico legado com vazio? Migre dados: procure vazios, marque como 'Outro' (neutro), depois bloqueia novo vazio. Relatório fica robusto.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ACD-003 / decisão: motivo_categoria nullable

### D179 — Campo de motivo/observação da realocação é obrigatório ou opcional?
- [ ] **vou fazer** · fluxo: Mudança de estoque entre prateleiras (reabastecimento de picking)
- **Imagina assim:** Operador move 5 caixas de um lugar pra outro. A tela pede 'Motivo / contexto...', mas operador deixa em branco e clica executar.
- **Hoje:** Campo é opcional — sistema deixa passar sem motivo. Fica gravado como vazio. No histórico depois, mostra 'motivo: —' (nada).
- **Por que importa:** Sem motivo, fica impossível entender depois por que a caixa saiu do lugar. Se um lote inteiro some, não tem rastreamento. Difícil investigar problema.
- **Opções:** (A) Deixar opcional: operador pode deixar em branco → Mais rápido pra operador. Mas perde rastreabilidade — não sabe depois por que mexeu.  ·  (B) Obrigatório: operador tem que digitar algo (ex: 'ajuste de estoque', 'separação de pedido', 'dano no produto') → Mais lento (operador digita), mas consegue ver depois o histórico completo e entender.
- **Recomendação:** Escolha a segunda. Obriga digitar. Vale a lentidão — depois, quando investigar erro de estoque, você sabe exatamente por que a caixa saiu.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/components/wms/ui/modals.tsx:1407

### D180 — Quando um operador cola um código de fornecedor com barra invertida ou caractere estranho (tipo ABC\-1234), o sistema deve aceitar ou rejeitar?
- [ ] **vou fazer** · fluxo: Equivalentes de Peças (Catálogo de Substituições)
- **Imagina assim:** Um operador cola um código de fornecedor que tem uma barra invertida na frente do traço. O sistema tem uma regra que valida letras, números, ponto e traço — mas não deixa claro se aceita escape de caracteres.
- **Hoje:** O sistema tira espaços, maiúscula, e valida com uma regra que verifica: letras (A-Z), números (0-9), ponto e traço. A barra invertida? Não confirmamos se o navegador/sistema é que escapa, ou se o operador tá colando mesmo assim.
- **Por que importa:** Se você não define isso, fica na dúvida: operador cola ABC\-1234, o sistema aceita como ABC-1234 (interpretado), ou rejeita por ter caractere fora da lista? Dependendo da escolha, você padroniza como a pessoa digita no Tiny.
- **Opções:** (A) Aceitar literal — o sistema normaliza e transforma barra-invertida-traço em traço normal. → Operador digita qualquer coisa estranha, o sistema limpa e funciona. Mais flexível, menos erro de rejeição.  ·  (B) Rejeitar — se achar barra invertida ou escape, avisa o operador 'código inválido'. → Operador sabe imediatamente que aquele copiar-colar tá errado. Mais rígido, força operador a copiar certo.
- **Recomendação:** Recomendo ACEITAR LITERAL. O sistema limpa automaticamente e o operador nunca fica travado por um caractere estranho. Código de fornecedor é vindo do Tiny — você pode assumir que dados do Tiny são meio bagunçados mesmo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:10, route.ts:22

### D181 — Quando um cliente pede um produto especifico e marca qual veiculo dele é compativel — o sistema deveria facilitar isso com sugestoes automaticas?
- [ ] **vou fazer** · fluxo: Compatibilidade de Veículos por Produto
- **Imagina assim:** Cliente pediu o produto 'NLA-123' (compativel com FIAT UNO 2015-2020). Na hora de confirmar o pedido, o cliente marca seu veiculo como 'FIAT UNO'.
- **Hoje:** O sistema mostra a lista de veiculos compativeis com o produto (lê do cadastro). Mas nao oferece sugestoes automaticas de qual veiculo o cliente devia escolher, nem valida se a escolha é realmente compativel na hora de enviar o pedido.
- **Por que importa:** Se o dono do negocio quer mesmo oferecer essa compatibilidade, deveria validar e/ou sugerir no pedido — senao fica como um cadastro que ninguém usa (so fica lá pra enfeite). Se nao quer validar, melhor cortar a funcionalidade pra nao confundir.
- **Opções:** (A) Usar o cadastro de compatibilidade pra sugerir automaticamente veiculos quando o cliente confirma o pedido → Cliente recebe ajuda. Sistema valida se escolhe algo compatível. Melhor aproveitamento do cadastro.  ·  (B) Deixar como está: cadastro informativo (so mostra, nao usa em lógica nenhuma). Tirar a sugestão. → Mais simples. Nao tira compatibilidade, mas fica claro que é so pra referência visual.
- **Recomendação:** Decida se quer validar compatibilidade ou não. Se quer, use em sugestão de produto no pedido (primeira opcão). Se não quer, deixa como está mas avisa ao operador que é só informativo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/cross/catalogo-queries.ts:176-202, src/app/wms/cross/[sku]/page.tsx:25-32

### D182 — Deveria deixar o operador editar o ano de validade de um veiculo ja cadastrado, ou manter só remover e re-adicionar?
- [ ] **vou fazer** · fluxo: Compatibilidade de Veículos por Produto
- **Imagina assim:** Operador percebeu que cadastrou 'FIAT UNO 2015-2020' mas deveria ser '2016-2020'. Quer corrigir.
- **Hoje:** O sistema so permite remover e adicionar de novo. Nao existe edicao no meio (PATCH). Operador precisa fazer dois cliques em vez de um.
- **Por que importa:** Afeta a facilidade do cadastro. Se deixar editar, fica melhor pra operador. Se manter só remove+adiciona, fica registrado que houve remocao (mais auditoria). Decidir entre comodidade ou rastreamento claro.
- **Opções:** (A) Permitir editar ano do veiculo na tela (PATCH/editar) → Um clique. Mais rápido pro operador. Mas precisa de mais código e precisaria registrar a mudança.  ·  (B) Manter como está: remove + re-adiciona → Deixa claro no histórico que removeu e adicionou. Mais simples. Operador faz dois cliques.
- **Recomendação:** Se o volume de edicoes é baixo (raro mudar ano), mantenha remove+adiciona (mais simples). Se o operador reclama muito, implemente editar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/cross/produtos/[sku]/veiculos/route.ts (POST/DELETE existem, PUT/PATCH não)

### D183 — E se o operador tentar adicionar veiculo a um produto que nao existe no cadastro? Deveria criar automaticamente ou rejeitar?
- [ ] **vou fazer** · fluxo: Compatibilidade de Veículos por Produto
- **Imagina assim:** Operador digita SKU='INEXISTENTE-999' tentando adicionar um veiculo compatível.
- **Hoje:** O sistema rejeita com erro '404: Produto nao encontrado'. Produto precisa ser criado antes em outro painel.
- **Por que importa:** Afeta o fluxo do operador. Se criar automaticamente, ganha velocidade. Se rejeitar, garante que o produto foi planejado/conferido antes.
- **Opções:** (A) Rejeitar e avisar 'Primeiro crie o produto SKU-999, depois adicione veiculo' → Operador é forçado a validar produto antes. Menos produtos 'perdidos' no sistema.  ·  (B) Criar o produto automaticamente (em branco) quando adicionar veiculo → Operador economiza clique. Mas pode gerar produtos vazios sem nome.
- **Recomendação:** Mantenha a rejeição (primeira opcão). Garante que o produto foi conferido. Se quiser melhorar, crie um fluxo que deixe visível: 'SKU novo? Clique aqui pra criar'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/cross/produtos/[sku]/veiculos/route.ts (GET valida existência)

### D184 — Corrigir estoque num galpão errado ou de empresa errada é possível. Como validar que operador tá mexendo no lugar certo?
- [ ] **vou fazer** · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Pedido é de Empresa A no galpão Curitiba. Operador tá com Empresa B selecionada na tela (galpão São Paulo). Clica editar estoque, manda São Paulo.
- **Hoje:** Sistema tenta encontrar empresa ativa em São Paulo. Se encontrar, processa. Se não encontrar, retorna erro. Mas não valida se o galpão que mandou é o mesmo galpão do pedido.
- **Por que importa:** Um operador confuso ou apressado pode mexer no estoque do galpão errado. Pedido fica em um galpão, estoque foi ajustado em outro.
- **Opções:** (A) Deixar como tá (validação indireta via product_id) → Funciona na maioria dos casos, mas há brecha se operador souber o ID de um produto que existe em outro galpão.  ·  (B) Validar explicitamente: galpão da requisição deve ser = galpão do pedido → Força correspondência 100%. Sem brechas.
- **Recomendação:** Opção 2: validação explícita. Força operador a tá no galpão certo. Impede confusões.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:66-78, 82

### D185 — NCM e origem fiscal vindo errado do Tiny — deixa vazio ou pula campo?
- [ ] **vou fazer** · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Tiny manda um código NCM ou origem fiscal inválido (texto aleatório tipo 'invalido-text'). Sistema tenta converter para número.
- **Hoje:** Quando converte 'invalido-text' para número, vira inválido (não é número). Sistema pula o campo, deixa vazio ou deixa valor antigo lá. Você fica sem saber se é realmente inválido ou se perdeu na conversão.
- **Por que importa:** NCM e origem fiscal são obrigatórios pra nota fiscal e cálculo de imposto. Se ficar vazio ou errado, nota sai errada. Auditoria, imposto, multa.
- **Opções:** (A) Deixar como está (pula, fica vazio ou antigo) → Nota sai sem NCM ou com origem errada. Risco fiscal.  ·  (B) Bloquear a sincronização e avisar qual produto tem NCM errado → Operador vê, avisa Tiny pra corrigir, depois sincroniza. Força correção na fonte.  ·  (C) Aceitar mas marcar produto como 'auditoria pendente' → Sincroniza, mas fica sinalizado pra alguém revisar depois. Menos bloqueador.
- **Recomendação:** Bloquear e avisar. NCM não pode estar errado — está ligado a imposto.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

### D186 — Mudar o tipo de uma prateleira (por ex: de picking para quarentena) quando tem estoque guardado nela — deixa mudar ou avisa?
- [ ] **vou fazer** · fluxo: Criar, editar e remover prateleiras
- **Imagina assim:** Prateleira A tem 100 unidades de Produto X e tipo 'picking'. Operador clica no tipo e troca para 'quarentena'. O estoque continua em A, mas agora é prateleira de quarentena.
- **Hoje:** O sistema deixa trocar o tipo — não avisa, não bloqueia. Tipo muda imediatamente no sistema e na tela (cor do badge muda na lista).
- **Por que importa:** Se a prateleira tem estoque, mudar de tipo pode confundir a operação. Exemplo: estoque estava em picking (zona de separação de pedidos). Vira quarentena (zona de produtos em dúvida). Depois quando buscarem Produto X pra um pedido, o sistema que encontra estoque vai considerar aquele estoque? Vai achar em quarentena, que é zona errada — separador não encontra.
- **Opções:** (A) Sempre deixa mudar (hoje) → Flexível — operador consegue ajustar tipo quando precisa. Risco: se tem estoque, tipo inconsistente confunde o lugar onde busca estoque  ·  (B) Deixar mudar, mas avisar: 'Esta prateleira tem 100 unidades. Tem certeza?' → Seguro e flexível — operador vê a quantidade e pode reconsiderar  ·  (C) Bloquear se tem estoque — só muda tipo se prateleira vazia → Muito restritivo — se precisa mudar tipo, operador tem que primeiro vazar a prateleira
- **Recomendação:** Avisar com quantidade — 'Esta prateleira tem 100 unidades. Ao mudar para quarentena, o estoque muda de zona. Continua?' Deixa mudar, mas deixa visível o que está acontecendo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/localizacoes/[id]/route.ts

### D187 — Quando o operador digita o código de uma prateleira (LOC-05-02), o sistema interpreta zona pelo prefixo ou usa campo separado?
- [ ] **vou fazer** · fluxo: Criar, editar e remover prateleiras
- **Imagina assim:** Prateleira com código 'A-05-02' — zona é 'A' (primeiro número antes do hífen). Se operador trocar tipo dessa prateleira, zona continua 'A' ou fica vazia?
- **Hoje:** Sistema tem campo 'zona' opcional no banco. Pode ser vazio — quando fica vazio, o código é lido: 'A-05-02' extrai zona 'A' automaticamente. Se zona foi preenchida manualmente (ex: zona='B' mas código='A-05-02'), eles ficam inconsistentes.
- **Por que importa:** Se zona está inconsistente (código diz A, zona manual diz B), sistema fica confuso — qual zona usar? Isso pode afetar o sistema que encontra estoque e organização do galpão.
- **Opções:** (A) Zona é sempre inferida do código (ignorar campo zona) → Simples, consistente. Mas perde flexibilidade de override se precisa reorganizar  ·  (B) Zona é campo separado; código é só identificador → Flexível, mas precisa garantir que operador enche campo zona quando cria prateleira  ·  (C) Quando troca tipo, zera zona (volta a inferir do código) → Meio termo — tipo muda, zona reseta pra padrão (código)
- **Recomendação:** Decida: zona é automática (do código) ou manual (campo)? Se manual, validação obrigatória ao criar. Se automática, apague campo zona do banco pra evitar inconsistência.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/types.ts

### D188 — Número muda entre visualizar lote e importar?
- [ ] **vou fazer** · fluxo: Importação em lote de prateleiras
- **Imagina assim:** Operador A visualiza um lote e vê: 'vou criar 100 prateleiras (95 novas, 5 já existem)'. Entre visualizar e realmente criar, operador B manualmente cria 10 prateleiras com mesmo prefixo. Operador A clica 'Criar' — na verdade, cria só 85 (porque 15 já existem agora).
- **Hoje:** Tudo funciona (insere o que consegue, retorna número real), mas os números no resumo ficam errados. Sistema mostra '85 criadas' quando operador esperava '100'.
- **Por que importa:** Operador fica confuso: 'digitei 100 no arquivo, ele diz que criou 85?' Não sabe o que aconteceu.
- **Opções:** (A) Avisar no sistema: 'números podem mudar se alguém criar prateleiras ao mesmo tempo' — documentar comportamento → Operador entende o que aconteceu, mas confusão pode persistir  ·  (B) Travar lote entre visualizar e criar — ninguém consegue mexer naquele prefixo durante esse tempo → Seguro e previsível, mas mais complexo de implementar  ·  (C) Fazer tudo de uma vez — não há visualização separada, só 'Criar agora' → Simplifica, mas perde validação prévia
- **Recomendação:** Opção A — explica o comportamento, operador entende e aceita
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts linha 94-110 (preview), linha 135-153 (create) — dois SELECTs independentes

### D189 — Símbolo que une o código das prateleiras — travessão ou underscore?
- [ ] **vou fazer** · fluxo: Importação em lote de prateleiras
- **Imagina assim:** Quando importar um lote com prefixo=A, h=1-10, v=1-5, sistema gera código tipo 'A-01-01, A-01-02... até A-10-05' (com travessão). Operador quer 'A_01_01' (com underscore). Deixar customizável ou manter padrão?
- **Hoje:** Travessão é fixo. Não há opção pra trocar. Operador que prefere outro símbolo não consegue.
- **Por que importa:** Padronização visual e compatibilidade com sistemas externos. Algumas empresas usam underscore em seus próprios códigos.
- **Opções:** (A) Deixar operador escolher o símbolo no formulário de importação — adiciona dropdown com opções → Flexível, operador customiza conforme quer  ·  (B) Manter travessão como padrão — sem opção → Simplifica, mas força padrão único  ·  (C) Documentar que o símbolo é travessão, e pronto — avisa na ajuda → Operador sabe antecipado e aceita
- **Recomendação:** Opção C — documenta padrão, simples e direto
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts linha 16-25 (LoteBody) — sem separador field

### D190 — Ao criar um produto novo manualmente, como garantir que não vai chocar com o fornecedor depois?
- [ ] **vou fazer** · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Admin clica + na tela de produtos, digita um código SKU que ele inventou, preenche descrição, clica Criar.
- **Hoje:** O sistema cria o produto e marca como 'não sincronizado' (sem vínculo com fornecedor). Depois, se admin tentar sincronizar, o sistema não acha o mapeamento e pula silenciosamente.
- **Por que importa:** Se você cria um produto manual com código 'PECA-001' e depois o fornecedor também tem 'PECA-001' (mas com descrição diferente), quando você sincronizar, aparece um novo produto duplicado na sua lista. Confusão total.
- **Opções:** (A) Validar contra o fornecedor ANTES de criar: 'Pode criar? Já existe lá?' e alertar se o código já existe → Admin decide: quer criar um novo mesmo ou quer vincular ao que já existe lá. Zero duplicação.  ·  (B) Alertar no UI: 'Atenção: produtos criados manualmente nunca sincronizam sozinhos. Você sempre vai ter que sincronizar à mão' → Deixa bem claro o que é automático e o que não é. Admin entra de olhos abertos.  ·  (C) Marcar visualmente como 'não elegível pra sincronização': deixa bem claro que esse produto nunca vai buscar dados do fornecedor → UI mostra visualmente qual produto é manual e qual é sincronizado. Sem confusão.  ·  (D) Deixar como tá (sem aviso) → Rápido hoje, mas riscos de duplicação amanhã.
- **Recomendação:** Opção 1 + 2 juntas: valida antes DE criar E coloca um aviso bem no topo. Custa pouco e evita cacos depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 1 em decidir

### D191 — Quando mostrar produtos desativados no sistema, qual informação é importante deixar visível?
- [ ] **vou fazer** · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Supervisor quer ver a lista de produtos que foram 'desligados' (não vendem mais) e quando isso aconteceu.
- **Hoje:** O sistema retorna a lista de inativos, mas no formulário só aparece 'data de última alteração geral' — não fica claro QUEM desativou, QUANDO desativou ou POR QUE.
- **Por que importa:** Se um produto importante foi desativado 'por acaso' (alguém clicou errado), você quer saber quem e quando pra desfazer. Além disso, pra conformidade, você precisa rastrear por que decisões foram tomadas.
- **Opções:** (A) Mostrar na lista: quem desativou + quando + motivo (anotação). Quando reclica 'ativar', registra quem ativou de novo. → Rastreabilidade completa. Você sabe o histórico de cada produto. Auditoria vira fácil.  ·  (B) Avisar: 'Desativar um produto com saldo vai gerar inconsistência — confirma?' → Operador para pra pensar. Reduz desativações acidentais. Evita descobrir depois que tinha 50 unidades perdidas.  ·  (C) Deixar como tá (sem informações) → Simples hoje, mas perda de rastreabilidade. Se questionar depois, não sabe responder.
- **Recomendação:** Opções 1 + 2 juntas. Crítico pra controle. Aviso + logs salvam muito tempo de investigação depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 2 em decidir

### D192 — Quando sincronizar um kit do fornecedor (produto que é composto por outros produtos), o que fazer se um componente tá faltando no seu sistema?
- [ ] **vou fazer** · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Fornecedor diz que produto 'ABCD12' é um kit com 2x COMP-001 + 3x COMP-002. Você sincroniza, mas 'COMP-002' nunca foi importado no seu sistema.
- **Hoje:** Sistema ignora 'COMP-002' silenciosamente, marca 'ABCD12' como kit mas faltam componentes. Depois, quando você tenta separar esse kit pro pedido, pode falhar porque não acha estoque de um componente (que tecnicamente não existe no seu banco).
- **Por que importa:** Um kit incompleto é um produto quebrado. Quando o separador tenta montar 'ABCD12' e não consegue achar 'COMP-002', a separação falha e o pedido fica travado. Pior: se ninguém percebeu, pode vir pra tela de edição com '0 unidades' e confundir.
- **Opções:** (A) Se faltar um componente, retornar erro: 'Não achei COMP-002 no seu sistema. Importe esse produto primeiro' → Admin sabe imediatamente que precisa fazer importação em massa de componentes antes. Kit fica correto.  ·  (B) Enfileirar automaticamente: 'Faltam componentes — vou tentar importar sozinho em segundo plano' → Sistema tenta se auto-recuperar. Menos trabalho manual. Mas pode falhar silenciosamente também.  ·  (C) Deixar silencioso (como é hoje) → Kit fica incompleto. Separador descobre o problema no pior momento possível: na hora do picking.
- **Recomendação:** Opção 1: erro claro + dica de solução. Depois considerar a 2 (enfileiramento automático) se vier muito componente faltando.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 3 em decidir

### D193 — Quando um kit é marcado como 'kit=sim' mas sem componentes, o que o sistema faz?
- [ ] **vou fazer** · fluxo: Cadastro de Produtos e Sincronização com Tiny
- **Imagina assim:** Um produto sincronizou como kit. Depois, alguém deletou todos os componentes manualmente ou sincronização rodou 2x e apagou as linhas.
- **Hoje:** Kit fica com 'kit=sim' mas zero componentes. Quando calcula disponibilidade, retorna 0 (não tem como montar um kit vazio). UI fica mudo — pode mostrar 'em falta' ou não mostrar nada.
- **Por que importa:** Produto fantasma. Kit inválido ocupando espaço no cadastro. Quando separador tenta usar, não consegue — e não tá claro por que. Confusão total.
- **Opções:** (A) Validação: bloqueie 'kit=sim' se não tem componentes — retorna erro 'adicione componentes primeiro' → Impossível deixar kit quebrado no banco. Sempre consistente.  ·  (B) Relatório de 'kits vazios': lista todos os kits que tão marcados mas sem componentes → Admin consegue revisar e corrigir regularmente. Menos fantasmas no banco.  ·  (C) Avisar quando sincronizar: 'Esse kit não tem componentes — quer ignorar ou quer que eu importe automaticamente?' → Admin decisão consciente na hora em vez de descobrir depois.  ·  (D) Deixar como tá → Kits vazios circulam no sistema. Confusão garantida.
- **Recomendação:** Opção 1 + 2: validação no banco (impede quebra) + relatório de manutenção (limpa de vez em quando). Rápido de implementar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** titulo/situacao do item 5 em decidir

### D194 — Pedido pede componente X solto E pede kit que contém X — como conta?
- [ ] **vou fazer** · fluxo: Produtos que são feitos de componentes (Kits)
- **Imagina assim:** Pedido: 5× Parafuso + 1× Kit Suporte (que tem 3× Parafusos). Estoque tem 10 parafusos no total.
- **Hoje:** Sistema soma tudo — 5 diretos + 3 do kit = 8 parafusos apartados. Nenhum aviso de duplicação. Registro mostra que 3 vieram do kit (campo kit_componente=true) mas não bloqueia.
- **Por que importa:** Operador pode pensar que comprou 5+1=6 coisas mas o sistema apartelha 8 parafusos. Estoque confuso. Ou pode ser intencional — precisa saber se permite redundância.
- **Opções:** (A) Deixar como está (soma tudo; rastreabilidade post-fato) → Devolve quem quer isso. Mais flexível, mas silencioso se foi erro.  ·  (B) Avisar quando detecta redundância (parafuso já dentro do kit) → Operador vê alerta, decide se remove o direto ou mantém  ·  (C) Bloquear e forçar corrigir (não deixa aprovar se tiver redundância) → Garante integridade; pode impedir pedidos legítimos (ex: preciso mesmo de 8 parafusos)
- **Recomendação:** Conversar com o dono de negócio: componentes dentro de kits podem ser redundantemente solicitados? Se não deve acontecer, ir com opção 2 ou 3. Se pode, opção 1 é ok desde que treine operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** webhook-processor-wms:237-257; origen_detalhes.kit_componente=true em ledger.ts:338

### D195 — Os fornecedores são compartilhados entre empresas ou cada empresa tem sua lista separada?
- [ ] **vou fazer** · fluxo: Cadastro de fornecedores
- **Imagina assim:** A empresa A cadastra um fornecedor chamado 'Tiger'. A empresa B, que usa o mesmo sistema, tenta cadastrar seu próprio 'Tiger' (é um fornecedor diferente, com outro CNPJ, outro telefone). O sistema não deixa — reclama que já existe 'Tiger'.
- **Hoje:** Hoje o sistema compartilha a lista de fornecedores entre todas as empresas. Não tem como cada empresa ter seu próprio 'Tiger'. Se a empresa B vincular um produto a 'Tiger', vai ficar vinculado ao 'Tiger' da empresa A.
- **Por que importa:** Os custos e prazos de entrega variam por fornecedor. A empresa A pode ter Tiger com prazo de 10 dias e a empresa B com 15 dias — números diferentes pro mesmo fornecedor. Se o sistema mistura, as compras podem sair erradas (mais caras ou atrasadas).
- **Opções:** (A) Manter fornecedores compartilhados (global) → Funciona só se Tiger, Lion e ACA forem DE VERDADE as mesmas empresas nas duas fábricas — mesmos CNPJ, mesmos contatos. Economiza de digitar tudo de novo. Mas se os fornecedores são diferentes, os dados vão se misturar e bagunçar.  ·  (B) Isolar fornecedores por empresa → Cada empresa tem sua lista separada. A empresa A tem 'Tiger A' e a empresa B tem 'Tiger B'. Mais trabalho no cadastro (duplica informação), mas cada uma controla seu custo e prazo com certeza.
- **Recomendação:** Confirme: o 'Tiger' que a empresa A usa é DO MESMO FORNECEDOR que a empresa B usa? (Mesmo CNPJ, mesmo telefone?) Se sim, compartilhe. Se não, isolem — a equipe de compras da empresa B não pode ficar na mão de um 'Tiger' que alguém lá na empresa A cadastrou errado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** fornecedores.ts:152-212, migration:20260522 line 8

### D196 — Admin quer buscar fornecedores que foram desativados. Como encontra um 'Tiger' velho que saiu de operação?
- [ ] **vou fazer** · fluxo: Cadastro de fornecedores
- **Imagina assim:** A empresa desativou 3 fornecedores (Tiger velho, Lion que faliu, ACA que saiu). O admin vê só 11 na lista. Semana que vem chega uma fatura de Tiger velho e precisa reativar. Como encontra?
- **Hoje:** Quando desativa um fornecedor, ele sumiu da tela. Não tem botão pra mostrar fornecedores inativos, nem busca avançada. É como se deletasse de verdade (mas a dados lá, só marcado como inativo).
- **Por que importa:** Um fornecedor foi importante no passado (tem 50 compras, muitos produtos vinculados). Se suma da tela, não dá pra reativar ou revisar histórico de custos. Admin fica sem opção.
- **Opções:** (A) Adicionar checkbox 'Mostrar inativos' → Aparece a lista completa (ativa + inativa). Fácil de reativar (clica no inativo e ativa de novo). Mas cluttera a tela com dados velhos no dia a dia.  ·  (B) Criar tela de arquivo/histórico separada → Fornecedores inativos em aba diferente ou filtro avançado. Tela limpa no dia a dia, mas precisa de mais código.
- **Recomendação:** Adicione um filtro simples ('Mostrar inativos' checkboxl) e uma ação pra reativar. Depois a empresa pode organizar melhor quando tiver tempo. Sem isso, fornecedor velho fica perdido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** fornecedores.ts:39, page.tsx (sem filtro)

### D197 — O sistema deve aceitar nomes iguais mas com maiúsculas e minúsculas diferentes?
- [ ] **vou fazer** · fluxo: Auto-cadastro de fornecedores
- **Imagina assim:** Operador criou manualmente um fornecedor chamado 'TIGER' (tudo em maiúsculas). Depois, o auto-cadastro tenta criar 'Tiger' (misturado). Trava.
- **Hoje:** O sistema trata 'TIGER' e 'Tiger' como nomes completamente diferentes. Se um já existe, o outro é bloqueado como duplicado.
- **Por que importa:** Se operador digitou errado a maiúscula e depois o auto-cadastro tentar com outra, trava. Ou você padroniza tudo igual, ou permite os dois.
- **Opções:** (A) Padronizar: auto-cadastro converte tudo para maiúsculas (ou minúsculas) antes de salvar → Sempre consistente. Se 'TIGER' já existe, auto-cadastro de 'Tiger' vai achar e não duplicar.  ·  (B) Deixar como está: quem criar manualmente tem que respeitar a maiúscula do padrão → Simples de programar, mas gera confusão. Operador não sabe que precisa digitar 'Tiger' e não 'TIGER'.  ·  (C) Interface não deixa digitar: dropdown com opções pré-aprovadas → Ninguém digita errado. Mais trabalhoso de programar.
- **Recomendação:** Padronizar tudo. Converta nomes para maiúsculas no momento de salvar. Simples e resolve de verdade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/fornecedores.ts:329-331

### D198 — Quando adicionar um novo fornecedor, precisa editar em dois lugares diferentes?
- [ ] **vou fazer** · fluxo: Auto-cadastro de fornecedores
- **Imagina assim:** Negócio fecha contrato com fornecedor novo (Bosch) que vai fornecer peças com prefixo 'BO'. Dev adiciona Bosch ao auto-cadastro, e o sistema cria Bosch. Mas depois, quando chega um pedido de 'BO123', o sistema roteia para 'Diversos' em vez de 'Bosch'.
- **Hoje:** Auto-cadastro tem uma lista de fornecedores e prefixos em um lugar. O roteamento de pedidos consulta outra lista separada. Quando um dev atualiza uma, a outra fica desatualizada.
- **Por que importa:** Fornecedor novo é criado, mas ninguém sabe rotear pedidos pra ele. Pedidos vão pro lugar errado. Alguém tem que atualizar manualmente em dois lugares diferentes, senão desincroniza.
- **Opções:** (A) Fazer auto-cadastro consultar a lista de fornecedores direto do registro de dados → Uma única fonte de verdade. Quando cria um fornecedor, o roteamento já sabe dele automaticamente.  ·  (B) Trazer a lista de roteamento pra dentro do registro de dados também → Mesma ideia. Ambas leem do registro, nunca desincronizam.  ·  (C) Deixar como está: dev tem que atualizar os dois lugares → Funciona, mas manual e propenso a erro. Alguém sempre esquece.
- **Recomendação:** Mover a lista de fornecedores+prefixos pro registro de dados. Assim auto-cadastro e roteamento consultam a mesma fonte. Dev só cadastra uma vez.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/fornecedores.ts:301-353, sku-fornecedor.ts:16-75

### D199 — Lançamentos retroativos podem ter data da chegada no passado (ex: a compra chegou 5 dias atrás mas operador está lançando hoje)?
- [ ] **vou fazer** · fluxo: Lançamento de Estoque em Emergência (retroativo)
- **Imagina assim:** Exemplo: fornecedor entrega um produto. Operador esquece de lançar. 5 dias depois, lembra e lança no sistema com data real de chegada (2026-05-28, quando hoje é 2026-06-02).
- **Hoje:** O sistema PERMITE. Armazena a data do passado normalmente. A data de criação do lançamento fica como 'hoje' (2026-06-02) pra rastreamento. Você pode filtrar relatórios pelo que foi realmente entregue se quiser auditoria detalhada.
- **Por que importa:** Auditoria e compliance. Você precisa saber 'quando realmente chegou' vs 'quando foi registrado'. Especialmente pra devolução de nota fiscal com fornecedor.
- **Opções:** (A) Aceitar data do passado (status quo). Operador digita dia correto. Tudo registrado com data real + data de lançamento. → Mais correto historicamente. Relatórios refletem realidade. Auditoria limpa. Operador precisa lembrar data exata.  ·  (B) Forçar data de hoje, ignorar quando realmente chegou → Mais rápido. Mas perde rastreabilidade. Depois não sabe se foi 1 dia ou 10 dias de atraso.  ·  (C) Alertar operador se data for > 2 dias atrás (confirma intenção antes de aceitar) → Meio-termo: protege contra erros, mas aceita atrasos justificados.
- **Recomendação:** Mantenha opção 1 (aceitar passado). Sua auditoria fica melhor. Adicione a opção 3 (alerta se > 2 dias) como proteção contra erros de digitação.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/lancamento-retroativo/route.ts:65-78


## Tema: Relatórios e indicadores (24)

### D200 — Operador que chegou semana passada quer saber: quantas movimentações esse recebimento teve? Quantos itens ficaram pendentes? Quanto custou? E poder ver o caminho completo da mercadoria.
- [ ] **vou fazer** · fluxo: Recebimento avulso (achado, devolução, ajuste manual)
- **Imagina assim:** Um recebimento de lote 'abc-123' foi criado 7 dias atrás. O operador volta agora e precisa resumir tudo que aconteceu com aquele lote.
- **Hoje:** O sistema não oferece uma página pra você clicar em 'lote abc-123' e ver a história completa. Você tem que ir em debug ou pedir pro técnico.
- **Por que importa:** O gerente de estoque precisa acompanhar se um lote velho parou no meio do caminho, quanto custou receber, quantas peças ainda estão encostadas. Sem isso, não consegue auditar se as coisas foram feitas.
- **Opções:** (A) Criar uma tela de auditoria no recebimento (quando você clica num lote, aparece linha do tempo completa: quanto chegou, quanto foi guardado, quando e por quem). → Operador consulta sozinho, sem pedir ajuda. Mais transparência, menos gambiarras.  ·  (B) Deixar como está (só operadores experientes conseguem extrair essa info de ferramentas de debug). → Continua dependendo de técnico. Lento, menos rastreável.
- **Recomendação:** Crie a tela de auditoria. É baixo custo, alto impacto. Operador ganha autonomia e você ganha rastreabilidade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:98 (lote_id = crypto.randomUUID()); origem_id compartilhado

### D201 — Registrar cancelamentos no histórico mesmo se a gravação falhar?
- [ ] **vou fazer** · fluxo: Cancelamento de Vendas
- **Imagina assim:** O vendedor cancela uma venda com sucesso — o estoque volta, o pedido é marcado como cancelado. Mas o banco de histórico (auditoria) estava indisponível naquele instante, então o registro de 'quem cancelou, quando, por quê' não foi gravado.
- **Hoje:** O sistema cancela a venda e retorna sucesso, mas se o histórico falhar em gravar, falha silenciosamente. O vendedor não vê nenhum aviso. Você sabe que a venda foi cancelada, mas o registro de quem fez (para auditoria) desapareceu.
- **Por que importa:** Histórico é crítico pra compliance, pra entender o que deu errado depois, e pra rastrear quem cancelou (especialmente se for devolução ou fraude). Se desaparecer, você perde a rastreabilidade. Pior: você acha que gravou mas não gravou.
- **Opções:** (A) Deixar como está (se falhar em gravar o histórico, falha silenciosamente) → Cancelamentos rápidos, mas histórico pode ter buracos. Auditorias futuras podem não achar o registro.  ·  (B) Fazer a gravação do histórico ser obrigatória. Se falhar, o cancelamento inteiro falha e o vendedor recebe erro → Mais lento, mas você tem certeza: ou cancelou com histórico, ou nada mudou. Zero buracos de rastreabilidade.  ·  (C) Manter gravação rápida em paralelo, mas se falhar enviar um alerta visual pra você revisar depois → Cancelamento rápido, e você sabe que teve um problema e pode corrigir manualmente se raro.
- **Recomendação:** Opção 2. Histórico não é opcional — se não conseguir gravar, o cancelamento não deveria acontecer. Vale o tempo de espera extra.
- **➡️ MINHA ESCOLHA:** 
- **Código:** flow-055

### D202 — Quando um operador procura um produto pelo nome — a busca acontece no computador dele ou no banco de dados?
- [ ] **vou fazer** · fluxo: Histórico de Movimentações de Estoque
- **Imagina assim:** Operador digita 'Freio' na caixa de busca do histórico de movimentações. O sistema filtra os registros que já estão na tela (no computador) ou faz uma nova busca no banco de dados?
- **Hoje:** O sistema filtra no computador. Quando você abre o histórico, ele carrega os 300 registros mais recentes. Quando você digita na busca, ele procura dentro desses 300 — não faz uma nova pergunta ao banco. Não há paginação (você não consegue ver registros mais antigos).
- **Por que importa:** Se um operador quer encontrar um registro de 1 ano atrás, a busca atual não vai encontrar porque o sistema só mostra os 300 mais recentes. Isso limita a capacidade de investigar históricos antigos ou conferir movimentações passadas.
- **Opções:** (A) Deixar como está (rápido, mas histórico limitado) → Operador consegue procurar rápido, mas não vê nada anterior aos últimos 300 registros.  ·  (B) Implementar busca de verdade no banco (mais lento, mas completo) → Operador consegue procurar qualquer registro antigo, mas a busca leva mais tempo.  ·  (C) Dar ao operador opção de escolher período (ex: últimos 3 meses, últimos 1 ano) → Equilibra rapidez e acesso ao histórico — busca funciona rápido dentro do período escolhido.
- **Recomendação:** Escolha a opção 3. Deixe o operador escolher o período que quer ver — assim ele consegue histórico completo quando precisa, mas a busca segue rápida.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/ledger/page.tsx:69, 82-95

### D203 — Quando você abre a página de estoque e deixa aberta por horas — os números que vê são hoje ou de quando abriu?
- [ ] **vou fazer** · fluxo: Consulta do saldo de estoque — quanto tem e onde tem
- **Imagina assim:** Você abre tela de estoque às 10h, vê ABC com 100 unidades. Deixa aberta. Às 15h, colega recebe 30 unidades de ABC. Você ainda vê 100 na sua tela.
- **Hoje:** Página não se atualiza automaticamente. Ela mostra dados que carregou quando você abriu. Você precisa pressionar F5 (atualizar página) para trazer números frescos.
- **Por que importa:** Você trabalha com informação desatualizada. Mentalmente pensa que tem 100, mas na verdade tem 130 (ou 70 se saíram). Oferece produtos que não tem ou não oferece o que tem. Pedidos roteados errado. Decisões erradas baseadas em números velhos.
- **Opções:** (A) Tela atualiza sozinha a cada 30 segundos — sempre fresco. → Mais banda de rede, mais carga no servidor. Mas você vê números atualizados em tempo real.  ·  (B) Tela atualiza quando você volta o foco pra aba (clica no navegador) — atualiza em silêncio. → Eficiente. Apenas quando você está olhando, traz fresquinho. Sem desperdício.  ·  (C) Deixar como está — você pressiona F5 quando achar que precisa. → Sem custo. Mas risco alto: você esquece de apertar F5 e trabalha com dado velho.
- **Recomendação:** Implementar a segunda opção. Quando sua aba recebe foco (você volta a olhar), traz dados frescos em silêncio. Melhor balanço entre segurança e eficiência.
- **➡️ MINHA ESCOLHA:** 
- **Código:** estoque/page.tsx:95-99, react-query defaults

### D204 — Dois relatórios (movimentações e saldos) têm filtros diferentes e números não batem — qual é a 'fonte da verdade'?
- [ ] **vou fazer** · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Você faz um ajuste manual de estoque: -5 unidades (erro de contagem). Relatório A (movimentações) não mostra. Relatório B (saldos) mostra. Qual relatório está certo? Qual acreditar?
- **Hoje:** Relatório A filtra só por tipo comercial (compra, venda, devolução cliente) — ajuste manual não é comercial, fica fora. Relatório B filtra tudo (comercial + operacional) — ajuste manual entra. Números não batem.
- **Por que importa:** Se dois relatórios falam coisas diferentes, qual você usa para decisão? Auditoria fica confusa. Um fala 100 unidades (A), outro fala 95 (B). Qual é a verdade?
- **Opções:** (A) Unificar: incluir ajustes manuais em AMBOS os relatórios → Números batem. Relatório A + B sempre dizem a mesma coisa. Simples, confiável. Mas relatório A fica 'sujo' com operacional.  ·  (B) Documentar a diferença: deixar como está (A = fiscal, B = físico), mas colocar explicação clara no cabeçalho de cada um → Flexível — você tem dois ângulos (fiscal vs físico). Mas exige que leitor entenda a diferença. Se não ler, fica confuso.  ·  (C) Criar terceiro relatório: 'Reconciliação' mostrando só os ajustes manuais que fazem números não baterem → Você vê especificamente o que é diferença. Bom para auditoria, mas mais uma coisa para clicar.  ·  (D) Excluir ajustes manuais de AMBOS (como estavam antes de surgir operacional) → Números voltam a bater. Relatório fica limpo — só fiscal. Mas você perde rastreio de ajuste manual, que é importante saber que existiu.
- **Recomendação:** Opção 1 ou 2: ou unifica (ajuste entra em ambos), ou documenta clara diferença (A=fiscal/B=físico) com aviso no cabeçalho. Auditoria ganha transparência.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/relatorios/movs-por-empresa/route.ts:54-61 vs src/app/api/wms/relatorios/saldos-por-empresa/route.ts:40-41

### D205 — Quando você pede para ver o custo de um mês (janeiro 2026), deveria ver o custo como estava em janeiro ou como está hoje?
- [ ] **vou fazer** · fluxo: Relatório de Custo Médio dos Produtos
- **Imagina assim:** Você pede um relatório: 'quero ver meu custo médio em janeiro de 2026'. Chama a tela com datas 01-01-2026 até 31-01-2026.
- **Hoje:** A tela mostra as entradas que chegaram em janeiro (aquelas que mexeram com o custo). Mas o custo médio exibido é o custo AGORA (junho de 2026), não como estava em 31 de janeiro. Exemplo: em janeiro, custo era 5. Você entra mais mercadoria em fevereiro, custo sobe para 8. Se pede relatório de janeiro HOJE, vê custo 8 — não 5.
- **Por que importa:** Histórico temporal fica enganoso. Se você quer auditar 'quanto custava meu estoque em janeiro?', precisa do custo de janeiro. Mostrar custo de junho quebra a auditoria. Decisão: o que faz mais sentido pro seu negócio?
- **Opções:** (A) Mostrar o custo CONFORME ESTAVA NAQUELE PERÍODO (em 31-janeiro) → Mais correto pra auditoria histórica. Precisa calcular custo regressivo (voltar no tempo a partir do registro das movimentações de estoque). Mais lento, mais complexo.  ·  (B) Mostrar o custo DE HOJE + indicador 'este é custo atual, não de janeiro' → Mais rápido. Mas relatório fica potencialmente enganoso se usuário não ler o aviso. Precisa da desclaração bem visível.  ·  (C) Criar dois relatórios: 'Histórico Temporal' (custo de cada período) vs 'Últimas Entradas' (com custo atual) → Mais claro semanticamente. Precisa implementar dois fluxos diferentes. Melhor experiência do usuário.
- **Recomendação:** Use opção 3: separe em dois relatórios. Um mostra 'entradas e custos do período' (custo de janeiro com mercadoria de janeiro). Outro mostra 'valor atual do estoque que tinha em janeiro' (custo hoje). Deixa claro qual pergunta você está respondendo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** historico-custo/route.ts:58-59, :66-70

### D206 — Um produto sai e entra várias vezes no mesmo dia (compra, venda, devolução). O relatório deve mostrar todas as movimentações ou só as entradas?
- [ ] **vou fazer** · fluxo: Relatório de Custo Médio dos Produtos
- **Imagina assim:** 02-02-2026: 8h entra 10 unidades a 5 reais (custo sobe para 5). 10h entra mais 5 unidades a 8 reais (custo sobe para 6.67). 14h sai 8 unidades (saldo fica 7, custo permanece 6.67). 16h entra 2 unidades a 10 reais (custo sobe para 7.43).
- **Hoje:** O relatório retorna só as 3 entradas, em ordem de hora. Saída de 8 unidades não aparece (porque saída não tem custo de compra, não afeta custo médio). Gráfico mostra 3 pontos de custo (5 → 6.67 → 7.43). Saída de 8 unidades fica invisível.
- **Por que importa:** Relatório chama-se 'Histórico de Custo', não 'Histórico de Estoque'. O propósito é auditar quanto você pagou (custo médio), não quanto saiu. Omitir saídas é tecnicamente correto. MAS se você quer entender 'quando meu estoque desceu?', esse relatório não responde. Pode confundir.
- **Opções:** (A) Mostrar só entradas (manter como está) → Correto pro propósito 'custo'. Mas precisa avisar na tela: 'Exibe apenas ENTRADAS — saídas não mudam o custo médio, por isso não aparecem'.  ·  (B) Mostrar todas (entradas, saídas, ajustes) → Timeline completa de movimento. Mas gráfico fica poluído com linha cinza (saídas) + linha azul (custo) — confunde qual é qual.  ·  (C) Criar dois relatórios: 'Custo Médio' (só entradas) + 'Todas as Movimentações' (entrada/saída/ajuste) → Cada um responde uma pergunta diferente. Mais claro, mas mais trabalho pra implementar.
- **Recomendação:** Mantenha como está (só entradas), mas adicione um aviso claro na tela: 'Este relatório mostra quando o CUSTO MÉDIO mudou, não quando o estoque entrou/saiu. Saídas são omitidas porque não afetam o custo.' Se precisa de timeline completa de movimentação, cria um segundo relatório.
- **➡️ MINHA ESCOLHA:** 
- **Código:** historico-custo/route.ts:55, page.tsx:301-312

### D207 — Widget de insights financeiros mostra custo de movimentação antiga que pode ter mudado depois — tem que avisar?
- [ ] **vou fazer** · fluxo: Relatório de Custo Médio dos Produtos
- **Imagina assim:** Widget mostra últimas 50 ajustes de custo (últimos 30 dias), incluindo um ajuste manual que registrou custo 8 reais em 15-02-2026. Depois em 26-02 um grande recálculo (reprocessamento) refez o custo médio de alguns produtos. Agora o produto tem custo 5 reais.
- **Hoje:** Widget mostra o ajuste antigo com 'custo 8', mas o custo médio do produto AGORA é 5. Descalibrado — nem é erro funcional (registrou custo 8 mesmo), mas visualmente confunde: 'o produto custava 8, mas agora custa 5 — onde foi o dinheiro?'.
- **Por que importa:** Insights financeiros servem pra você entender 'quanto gastei em estoque'. Se valores antigos e atuais não casam, você pensa que tem erro. Precisa avisar se a coluna 'custo' do widget é 'custo quando aconteceu' ou 'custo do produto agora'.
- **Opções:** (A) Mostrar custo COM DATA E HORA: 'custo em 15-02 era 8, custo em 02-06 é 5' → Mais claro semanticamente. Precisa adicionar coluna. Respeita o histórico real.  ·  (B) Mostrar custo antigo só — campo 'custo original do movimento' → Mais simples, já existe no código. Mas precisa avisar: 'Este é custo quando a movimentação aconteceu, não custo agora'.  ·  (C) Mostrar AMBOS: 'custo original' + 'custo recalculado agora' → Máxima clareza, mas widget fica poluído com mais colunas.
- **Recomendação:** Use opção 1: mostre custo com data. Adicione coluna 'custo em [data]' e 'custo agora'. Widget fica um pouco maior, mas responde a pergunta real: 'por que meu custo mudou de 8 para 5?' — porque o custo da categoria inteira foi recalculado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** insights/financeiro/route.ts:21-31

### D208 — Qual é a tolerância certa? Se há diferença de 3 peças, o relatório deve avisar?
- [ ] **vou fazer** · fluxo: Conferência de estoque entre WMS e Tiny
- **Imagina assim:** Você escolhe um 'limite de alerta' (threshold). Exemplo: threshold=5 significa 'só me avisa se faltar 5 ou mais peças'. Threshold=1 significa 'qualquer diferença me interessa'.
- **Hoje:** Sistema está com threshold=5. Diferenças menores (1, 2, 3, 4 peças) não aparecem no relatório. Diferenças iguais ou maiores (5+) aparecem.
- **Por que importa:** Você controla o ruído vs. a segurança. Se threshold é muito alto, ignora pequenos problemas que crescem. Se é muito baixo, fica recebendo aviso de 1 peça, cansa.
- **Opções:** (A) Alerta em qualquer diferença, até 1 peça → Máxima auditoria, rígido. Bom pro começo quando quer verificar se sincronização presta. Pode ter muito aviso falso (atrasos de 1-2 peças normais).  ·  (B) Alerta só se faltar 5 ou mais peças → Equilíbrio. Ignora pequenos atrasos, foca em problemas de verdade.  ·  (C) Alerta só de diferenças grandes, 10 ou mais peças → Pouco rigoroso, assume que dinheiro de 3-9 peças não importa. Bom se tiver muita sincronização lenta normal.
- **Recomendação:** Comece com alerta em qualquer diferença por 1-2 semanas (ajuste fino, vira natural). Depois mude pra aviso a partir de 5 peças em operação normal. Se tiver produtos caros, mantenha alerta em 1 ou 2.
- **➡️ MINHA ESCOLHA:** 
- **Código:** page.tsx:81-90; reconciliacao-tiny.ts:117

### D209 — Dashboard mostra 51 itens, mas sabe que existem 500+. Qual número mostrar pro supervisor?
- [ ] **vou fazer** · fluxo: Painel de Tarefas da Guarda
- **Imagina assim:** Dashboard de guarda pendente filtra e mostra 'mostrando 50 itens'. Supervisor abre a lista completa e vê 500 itens na fila. Não combina. Supervisor não sabe se há mais itens fora da tela ou se dashboard tá errado.
- **Hoje:** Dashboard carrega só os primeiros 50 itens (limite técnico pra não travar a tela). Mostra cota '50'. Se há 500 reais na fila, o cota mostra apenas 50 — silencioso, sem avisar que há mais.
- **Por que importa:** Supervisor toma decisão errada: 'Só faltam 50 pra guardar' quando na verdade há 500. Puede subalocar operador, atrasa toda produção. Ou inverte: acha que é muita coisa e pede urgência desnecessária.
- **Opções:** (A) Aumentar limite pra 500 (mostra todos, mas tela fica lenta) → Supervisor vê número real. Tela pode pesar (tablet trava enquanto carrega 500 itens), afeta experiência.  ·  (B) Manter 50, mas mostrar aviso 'mostrando 50 de 500+ itens' com botão 'Ver mais' → Deixa claro que há mais. Supervisor sabe que não vê tudo. Clica 'Ver mais' se quiser rolar.  ·  (C) Mostrar só o número total ('500+ pendentes') sem listar todos, apenas resumo → Rápido, claro. Perde detalhe de quem tá guardando, demora.
- **Recomendação:** Use opção 2 (aviso + botão). No dashboard, onde mostra os 50, adicione embaixo 'mostrando 50 de 500+ itens — clique para ver todos'. Supervisor não se confunde, continua rápido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/dashboard-tarefas.ts:187, 819, 955

### D210 — Como o sistema deve buscar dados de devoluções quando ninguém especifica um período?
- [ ] **vou fazer** · fluxo: Dashboard de Devoluções
- **Imagina assim:** Um operador abre a tela de devoluções sem escolher nenhuma data. O sistema precisa decidir: mostrar apenas as de hoje, ou as de todo mês?
- **Hoje:** O sistema começa procurando por devoluções de hoje (das últimas 0 horas). Se ninguém pediu nada diferente, a lista fica vazia, e o gráfico não aparece — parece que não houve devolução alguma.
- **Por que importa:** Um operador novo precisa saber rapidinho quantas devoluções chegaram neste mês, não só hoje. Se a página abre sem nada, ele não consegue se situar. A maioria das empresas quer ver o mês inteiro por padrão, não o dia.
- **Opções:** (A) Deixar como está: mostrar só devoluções de hoje → Usuário que quer ver mais precisa clicar para mudar. Mais controle, mais cliques.  ·  (B) Mudar o padrão para os últimos 30 dias → Página abre com dados, operador vê o movimento de um mês inteiro de primeira. Mais informação de cara.
- **Recomendação:** Mude o padrão para 30 dias. Qualquer um consegue clicar e escolher 'hoje' se quiser, mas a maioria vai aproveitar a visão do mês.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:14, queries.ts:134

### D211 — Como classificar os produtos por importância — curva A, B, C — globalmente na empresa ou por galpão separado?
- [ ] **vou fazer** · fluxo: Visão de Saúde do Estoque
- **Imagina assim:** O sistema tem dois galpões: um grande (Galpão A com 1000 pedidos/mês) e um pequeno (Galpão B com 100 pedidos/mês). Um parafuso que vende 5 unidades por mês em B deveria ser 'crítico pra B' mas desaparece como 'tipo C' quando vê a lista geral.
- **Hoje:** O sistema calcula a curva ABC olhando TODA a empresa junto. Os 20% de produtos com maior giro absoluto entram na curva A (tipo Galpão A domina). Um parafuso com 5 vendas/mês em B fica tipo C porque não tem giro alto comparado com os 200+ itens que vendem no Galpão A.
- **Por que importa:** Cada galpão tem dinâmica diferente. O que é crítico em B pode ser lento em A. Se o gerente de B vê 'tipo C', não faz reposição de emergência quando deveria. Se usa a curva A global pra decidir compra, erra o estoque de cada ponto.
- **Opções:** (A) Mudar a curva ABC pra ser SEPARADA por galpão (A tem sua curva A/B/C, B tem a sua). A divisão dos dados agora se faz diferente pra cada galpão → Parafuso com 5 vendas/mês em B vira 'tipo A de B' (crítico pra B). Dashboard mostra realidade de cada local. Comprador planeja reposição certa pra cada galpão  ·  (B) Manter curva ABC global mas exibir na UI: 'Curva A significa maior giro DA EMPRESA, não desse galpão'. Mostrar giro real (número de vendas últimos 30d) junto → Operador entende melhor, mas risco de continuar usando a curva errado pra decidir compra por galpão  ·  (C) Criar dois painéis separados: 'Curva ABC Global' (empresa inteira) e 'Top 10 por giro em cada galpão' (ranking local) → Mais informação, mas operador pode ficar confuso qual usar pra decisão
- **Recomendação:** Opção 1: separa a curva por galpão. É como funciona em WMS real — cada ponto tem seus críticos. Alinha com o modelo que vocês já têm (estoque é '3D': produto × galpão × prateleira).
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260529_wms_curva_abc.sql linhas 7-22; 20260527_insights_rpcs_3d_patch.sql linha 99

### D212 — Os números de importância (curva A, B, C) devem atualizar a cada hora ou uma vez por dia?
- [ ] **vou fazer** · fluxo: Visão de Saúde do Estoque
- **Imagina assim:** O parafuso X às 00:00 tinha saldo de 500 peças e era tipo C (venda lenta). Entre 00:00 e 14:00 vendeu 200 peças. Agora tem 300 e está saindo 200/dia (crítico!). Mas o dashboard ainda mostra 'tipo C' porque a classificação só recalcula uma vez por dia, às 00:00.
- **Hoje:** O sistema recalcula a curva ABC uma única vez por dia (00:00). Um produto que virou crítico entre 00:00 e 14:00 fica com a tag velha o dia inteiro.
- **Por que importa:** Comprador vê 'tipo C', não acha que precisa fazer compra de emergência. Produto sai rápido, quebra estoque. Operador confia num número que não reflete a realidade das últimas horas.
- **Opções:** (A) Atualizar a curva ABC a cada 1 hora (ao invés de 1x/dia) → Parafuso X que ficou crítico entre 00:00-14:00 vira 'tipo A' antes das 15:00. Comprador vê alerta quente e faz reposição rápido  ·  (B) Calcular curva ABC ao abrir a página — sempre fresco, sem ficar em cache antigo → Sempre mostra realidade do momento. Mais processamento. Pode ficar lento se tiver muitos SKUs  ·  (C) Manter atualizando 1x/dia, mas mostrar na tela quando a classificação foi calculada e exibir o giro REAL de hoje ('Curva: C (calculada 00:00). Giro real hoje: 200 un/dia = CRÍTICO') → Operador vê aviso de que o número é de 00:00 e consegue ler o giro atualizado na mesma página. Mais contexto, sem precisar mudar a arquitetura
- **Recomendação:** Opção 3 é mais rápida (só muda a tela). Opção 1 (1h de atualização) é melhor no longo prazo — boa prática é não deixar classificação muito velha. Comece com opção 3, depois evolui pra 1.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260527_cron_curva_abc_refresh_diario.sql; 20260529_wms_curva_abc.sql

### D213 — Qual é o limite pra sinalizar um produto como 'parado no estoque' — quanto tempo sem vender e qual valor mínimo?
- [ ] **vou fazer** · fluxo: Visão de Saúde do Estoque
- **Imagina assim:** O sistema mostra uma lista de 'produtos parados no estoque' (itens que não saem). Mas hoje o limite está na mão do programador — só entra na lista quem ficou parado 60 dias E custa no mínimo R$ 100. Uma ferramenta cara (R$ 80) que ficou parada 45 dias não aparece na lista. Operador descobre só no inventário anual.
- **Hoje:** O sistema classifica como 'parado' só se tempo >= 60 dias E valor >= R$ 100. Esses números estão escritos direto no código do sistema.
- **Por que importa:** Se o limite é muito relaxado (60d E R$100), itens de valor pequeno ou pouco movidos sumirem do radar. Se o limite é muito apertado, vai ficar lotado de avisos falsos. Precisa ser do jeito certo pro seu negócio.
- **Opções:** (A) Deixar os limites (60 dias, R$ 100) como estão, documentar na intranet: 'Item parado = parado 60+ dias E valor R$ 100+' → Operador sabe o critério, evita surpresa no inventário. Mas itens pequenos/baratos podem continuar invisíveis  ·  (B) Criar uma tela de configuração onde o gerente define: 'Item parado é parado X dias E valor >= R$ Y'. Guardar em tabela de regras → Cada galpão ou categoria pode ter limite diferente. Mais trabalho (design + código), mas muito mais flexível  ·  (C) Mudar os números agora pra algo mais apertado: ex, 45 dias E R$ 50. Documentar como padrão → Mais itens em aviso, mas gerente vai pegar antes os 'esquecidos'. Pode gerar excesso de alerta
- **Recomendação:** Opção 2 é o certo (torna configurável). Mas se quer rápido agora, faz opção 1 (documenta) ou opção 3 (muda valores). Qual é a prioridade?
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260527_insights_rpcs_3d_patch.sql linhas 18-65 e linhas 23-24; /api/wms/insights/estoque/route.ts linha 24

### D214 — Mostrar operador novo (que nunca fez nada) no painel de desempenho?
- [ ] **vou fazer** · fluxo: Produtividade e ranking dos operadores
- **Imagina assim:** Operador entra no sistema. Ainda não separou nada, não embalou nada, 0 ações. Aparecer no ranking?
- **Hoje:** Sistema marca como 'sem atividade'. Só entra no ranking se fizer pelo menos 1 ação.
- **Por que importa:** Gerente quer saber quem é novo e ainda não trabalhou vs. quem está inativo (não fez nada em dias). Ajuda a identificar se é iniciante ou se pode estar ocioso.
- **Opções:** (A) Mostrar no painel com rótulo 'novo, 0 ações' — fica claro que é iniciante, não é problema. → Gerente vê logo quem é novo. Evita confundir com inatividade.  ·  (B) Manter como está: só aparece quando fizer primeira ação. → Painel mais limpo. Mas gerente não vê quem entrou recentemente.
- **Recomendação:** Mostre com rótulo 'novo, 0 ações'. Ajuda a diferenciar iniciante de inativo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/insights/queries.ts:51-61; migration 20260515 linhas 286-314

### D215 — Contar desempenho de operador que trabalhou só 30 minutos?
- [ ] **vou fazer** · fluxo: Produtividade e ranking dos operadores
- **Imagina assim:** Operador trabalhou só meia hora (1 intervalo de tempo). Separou 10 itens. Sistema calcula '10 itens por hora'.
- **Hoje:** Sistema calcula e mostra '10 itens/hora' na tela — tecnicamente correto, mas com amostra muito pequena.
- **Por que importa:** Amostra de 30 minutos é muito curta pra avaliar desempenho. Amanhã esse mesmo operador pode fazer 4 itens/hora. Número não é comparável com quem trabalhou 8 horas.
- **Opções:** (A) Manter como está: mostra o número de qualquer forma, mas deixa claro que é 'amostra mínima' na tela. → Dados honestos. Usuário lê que é amostra pequena.  ·  (B) Não mostrar taxa de itens/hora se menos de 2 horas: deixa em branco ou mostra '—'. → Mais limpo. Não confunde com números de amostra grande.
- **Recomendação:** Deixe como está e mostre 'amostra de 30 minutos' na tela. Usuário saiba que número é provisório.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/insights/pessoas/page.tsx:59; migration 20260515 linha 220

### D216 — Quando alguém fecha um alerta, o sistema continua avisando
- [ ] **vou fazer** · fluxo: Sistema de alertas de problemas críticos (que some de vista)
- **Imagina assim:** Operador fecha aviso de 'Tempo de separação fora do padrão: 3h40 vs histórico 2h20'. Sistema marca como fechado. Cinco minutos depois, motor automático roda análise novamente e alerta reaparece na tela.
- **Hoje:** Alerta é marcado como dispensado_em=NOW, sai da tela. Ninguém sabe quem fechou ou por quê. Motor em 5 minutos roda fluxo novamente independente.
- **Por que importa:** Operador perde confiança (fechei, por que voltou?). Ninguém consegue rastrear quais avisos foram deliberadamente ignorados. Sistema parece descontrolado.
- **Opções:** (A) Deixar reaparecer sempre que a análise automática rodar → Ganha automatismo puro. Perde rastreamento e causa confusão no operador.  ·  (B) Quando alguém fecha, respeitar isso. Reabre só se a situação piorar muito (ex: tempo ir de 2h para 5h, não de 2h para 2h10) → Operador confia que foi ouvido. Você consegue rastrear quem fechou e quando. Aviso reabre se virar crítico de novo.
- **Recomendação:** Escolha a segunda opção. Seu operador mereceria ser respeitado. Se ele fechou e julgou que não é problema, deixe ele em paz. Reabra só se piorar demais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** insights-strip.tsx:43-48; motor.ts:44-141

### D217 — Seu supervisor aprova uma compra urgente, mas o aviso continua lá
- [ ] **vou fazer** · fluxo: Sistema de alertas de problemas críticos (que some de vista)
- **Imagina assim:** Sistema avisa 'Risco de falta — tempo de chegada saiu de 4 dias para 7 dias' (P90 fora do padrão: 1.8x do histórico). Supervisor clica, vê que é crítico, aprova compra de reposição em outro fornecedor (sai hoje, chega em 3 dias). Compra é aprovada no sistema. Mas o aviso continua piscando no dashboard.
- **Hoje:** Supervisor aprova a OC no WMS. Ação fica registrada lá (rota aprovar OC). Mas o aviso em alertas não sabe que foi tomada uma ação — continua exibindo até ser manualmente fechado ou expirar. Motor roda em 5 minutos; só deixa de recriar o aviso se o tempo de chegada realmente melhorar nas últimas 24h (porque começou embalar mais rápido).
- **Por que importa:** Supervisor pensa: 'Resolvi aqui, por que continua aparecendo?'. Perde incentivo. Você perde a trilha: qual aviso levou a qual ação tomada? Qual supervisor foi rápido pra resolver?
- **Opções:** (A) Deixar como está: avisos e ações em silos separados → Automatismo funciona isolado. Mas você não vê a conexão entre problema e solução.  ·  (B) Quando uma ação real é tomada (OC aprovada, etc), marcar automaticamente o aviso associado como resolvido e tirar da tela → Supervisor vê que resolveu. Você tem a trilha inteira (aviso → ação → resolvido). Confiança sobe.
- **Recomendação:** Escolha a segunda opção. Seu supervisor merecia feedback visual que resolveu. E você merecia saber a trilha: quem viu o aviso, o que fez, quando resolveu.
- **➡️ MINHA ESCOLHA:** 
- **Código:** motor.ts:44-141

### D218 — Quando você afina o gatilho de um alerta, como garantir que não vira spam?
- [ ] **vou fazer** · fluxo: Sistema de Alertas e Sinais de Anomalia
- **Imagina assim:** Sua regra 'fluxo andando lento' está detonando com frequência demais. Você testa abaixando o gatilho (deixa mais sensível). No teste, em vez de 3 avisos, aparecem 12. Você aprova a mudança. Meia hora depois, o sistema gera 9 novos avisos de galpões que antes não appareciam.
- **Hoje:** O sistema permite você colar o novo número direto sem validação. Ninguém impede você de colocar um número maluco (tipo zero ou negativo).
- **Por que importa:** Se o gatilho fica muito sensível, você pode virar escravo de notificações falsas. Se virar muito insensível, perde avisos reais.
- **Opções:** (A) Deixar como está: quem errar sofre as consequências → Liberdade total, mas risco de gerar spam acidental ou perder avisos reais.  ·  (B) Forçar sempre fazer teste antes de ativar a mudança → Mais seguro (você vê 12 avisos no teste antes de comprometer), mas mais burocrático.  ·  (C) Colocar limites automáticos (mínimo e máximo permitido) → Sistema recusa número maluco. Você nunca consegue colocar um valor errado por distração.  ·  (D) Avisar se a mudança vai aumentar muito os avisos → Você faz a mudança, sistema diz 'isso vai gerar 9 novos avisos em vez de 3', você confirma ou cancela.
- **Recomendação:** Combinar limites automáticos + aviso de impacto. Você não consegue colar um número maluco, e quando afina, vê quantos avisos a mais vai gerar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sistema de Alertas e Sinais de Anomalia")

### D219 — É permitido desligar completamente a espera entre repetições de um alerta?
- [ ] **vou fazer** · fluxo: Sistema de Alertas e Sinais de Anomalia
- **Imagina assim:** Você tem uma regra que avisa sobre algo. Há um campo que controla quantos minutos o sistema espera antes de avisar de novo sobre a mesma coisa. Alguém acidentalmente coloca zero.
- **Hoje:** Tecnicamente o sistema permite que isso aconteça, e quando isso ocorre, a regra para de avisar porque a lógica interna fica confusa.
- **Por que importa:** Se a espera for zero, o sistema poderia avisar a cada segundo sobre a mesma coisa, enchendo seus logs. Se for impedido, evita o caos.
- **Opções:** (A) Permitir zero (nenhuma espera, máxima frequência) → Você recebe alerta ininterruptamente enquanto a condição existir — pode ser caótico.  ·  (B) Exigir no mínimo 1 minuto de espera → Você nunca recebe o mesmo alerta mais de uma vez por minuto — mais controlado.
- **Recomendação:** Exigir no mínimo 1 minuto. Previne spam e comportamento inesperado.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sistema de Alertas e Sinais de Anomalia")

### D220 — Quando o operador muda o desenho do rótulo (template) no PrintNode, e depois clica Reimprimir em um rótulo antigo, qual versão do desenho sai? A antiga ou a nova?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta quando falha
- **Imagina assim:** 2 dias atrás: rótulo id=abc123 foi impresso com desenho 'versão 1' (sem QR code). Hoje, o gerente atualizou o template no PrintNode (adicionou QR code com código da NF). Operador vê o rótulo antigo com problema e clica 'Reimprimir'. A impressora recebe qual versão?
- **Hoje:** O sistema guarda o desenho exato do rótulo do dia que foi criado (congelado há 2 dias). Quando reimprimi, reenvia esse desenho antigo. O rótulo sai sem o QR code novo.
- **Por que importa:** Rótulos antigos e novos circulam diferentes no mesmo galpão. Na devolução ou auditoria, fica confuso qual padrão seguir. Pode dar problema com leitora de código.
- **Opções:** (A) Sempre usar o desenho atual (do template novo). Reimprimir usa o novo template, não o antigo. → Todos os rótulos saem iguais. Mas se houve mudança intencional de padrão, pode revelar rótulos que deveriam ser diferentes.  ·  (B) Manter o desenho antigo (como é hoje), mas avisar ao operador: 'Você vai reimprimir com desenho de 2 dias atrás. Novo template disponível em X minutos.' → Operador fica ciente, pode escolher esperar ou reimprimir mesmo. Mais responsabilidade do operador.  ·  (C) Criar uma opção 'Reimprimir com novo desenho' (separada de 'Reimprimir com desenho antigo'). Operador escolhe. → Máxima flexibilidade. Mas pode confundir — quando usar cada uma?
- **Recomendação:** Opção 2 — mostre data/hora do desenho usado e avise se existe um novo. Deixa a escolha com o operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** retry/route.ts, siso_impressoes_log.payload_zpl

### D221 — Um rótulo foi impresso com sucesso há uma semana, e agora o operador quer reimprimir ele. Como o sistema reage — permite ou bloqueia?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta quando falha
- **Imagina assim:** Rótulo id=old123 foi impresso normalmente em 2026-05-20 às 14:30 (status='sucesso'). Hoje, 2026-06-02, o gerente quer auditar o lote e vê que aquele rótulo era importante reimprimir (perdeu a cópia física). Operador clica Reimprimir. O botão faz algo ou mostra erro?
- **Hoje:** O sistema bloqueia — retorna código de erro 409 'já foi impresso com sucesso'. Operador não consegue reimprimir nada que já funcionou.
- **Por que importa:** Reimprimir rótulos históricos é comum quando há auditoria, conferência, ou recuperação de documento perdido. Se o sistema bloqueia, operador fica preso.
- **Opções:** (A) Permitir reimprimir mesmo de status 'sucesso' (não bloquear). Continua reenviando para impressora normalmente. → Operador consegue reimprimir quando precisa. Risco: é mais fácil reimprimir acidental.  ·  (B) Manter bloqueio em 'sucesso', criar botão separado 'Reimpressão' (não é retry, é reimpressão). Esse botão permite rerrodas de 'sucesso'. → Deixa clara a intenção (nova tentativa = botão Retry / segunda cópia = botão Reimpressão). Mais seguro.  ·  (C) Permitir reimprimir de 'sucesso', mas exigir senha/confirmar: 'Tem certeza que quer reimprimir um rótulo de 2 dias atrás?' → Protege contra acidente. Gerente tem que confirmar.
- **Recomendação:** Opção 2 — criar botão separado 'Reimpressão' para casos de 'sucesso'. Deixa claro o que operador está fazendo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** retry/route.ts:43-45

### D222 — Quando operador reimprimi a mesma etiqueta várias vezes no mesmo dia, devemos guardar um histórico ou deixar como está agora (sem rastrear)?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta de separação
- **Imagina assim:** Operador #3 reimprimi o pedido #9999 cinco vezes em 10 minutos (testa, nota erro, tenta novamente, etc). Gerente quer saber depois: quantas vezes foi reimpresso? Quem reimprimi? Quando foi a primeira vez?
- **Hoje:** Sistema não guarda histórico de reimpressões. A gente registra que tentou imprimir, mas não rastreia quantas vezes no mesmo dia ou quem foi. Só sabe que 'foi impresso'.
- **Por que importa:** Sem histórico, fica difícil auditar. Se aparece um problema depois (ex: 5 cópias da mesma etiqueta foram impressas), não consegue saber quando foi, quem foi e por quê.
- **Opções:** (A) Guardar histórico completo: data, hora, operador, quantas tentativas, quais falharam → Auditoria completa depois. Consegue rastrear tudo. Banco de dados fica um pouco maior.  ·  (B) Guardar só número de tentativas (contagem simples) → Menos dados. Sabe se reimprimi 1 ou 5 vezes, mas não quando foi cada uma.  ·  (C) Deixar como hoje (sem rastrear) → Zero overhead. Sem auditoria possível depois.
- **Recomendação:** Opção 1. Guardar histórico completo. Custa pouco (poucos bytes por reimpressão) e é crucial pra auditoria depois. Recomendo criar um registro tipo: 'Log de Reimpressões' com (pedido_id, data_hora, operador, motivo_se_houver, resultado). Ajuda a identificar padrões (ex: operador X sempre erra, impressora Y sempre falha).
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:108

### D223 — Operador não sabe que a nota já foi acertada. Tá procurando e não acha. Tem que avisar?
- [ ] **vou fazer** · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Dia 1 de junho: operador lança e acerta compra de 10 peças. Dia 8 de junho: mesmo operador volta na tela, procura pela nota (faz mentalmente 'será que acertei aquela?'), não acha. Fica na dúvida.
- **Hoje:** Sistema filtra 'notas pendentes' e remove as acertadas. Operador não vê as acertadas, então para ele 'sumiu'. Código está certo, mas operador fica perdido.
- **Por que importa:** Operador quer confirmar 'acertei aquilo?'. Não consegue resposta clara.
- **Opções:** (A) Mostrar aba 'Histórico' com notas acertadas — operador vê que acertou em 1º de junho. → Operador acha resposta, tranquilo.  ·  (B) Manter só 'notas pendentes', mas adicionar mensagem 'As acertadas não aparecem aqui'. Vira mais info no rodapé. → Menos poluído, operador aprende com o tempo.  ·  (C) Avisar por email/notificação quando acertar: 'Compra XYZ acertada em 1º de junho às 14h23'. → Operador tem confirmação na hora, não precisa voltar pra checar.
- **Recomendação:** Opção 1 — aba de histórico resolve, operador consulta quando quiser.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:559-591


## Tema: Tarefas automáticas e fila do sistema (22)

### D224 — Quando o recebimento da transferência falha no meio do caminho, o que fazemos com os itens que já foram movimentados?
- [ ] **vou fazer** · fluxo: Recebimento de Estoque Transferido de Outro Galpão
- **Imagina assim:** O operador clica receber transferência, o sistema começa a processar, consegue guardar 3 itens na prateleira, mas aí a conexão cai ou o servidor desliga no meio da operação.
- **Hoje:** O sistema tenta limpar o que estava em andamento, mas deixa a transferência parada com alguns itens já recebidos e outros não. Na próxima tentativa, ou o mesmo operador tenta novamente (se for da mesma pessoa) ou outro operador fica bloqueado dizendo que tem alguém mexendo.
- **Por que importa:** Se a transferência fica incompleta, o saldo no destino fica errado (alguns produtos contam como recebidos, outros não), e isso estraga o inventário. Além disso, se tentar receber novamente, pode contar a mesma mercadoria duas vezes.
- **Opções:** (A) Manter como está (best-effort): o sistema faz o possível pra limpar, mas aceitamos que pode sobrar itens órfãos → Mais rápido de implementar, mas alguém vai ter que mexer manualmente no banco de dados pra consertar. Risco de contar coisa duas vezes.  ·  (B) Fazer tudo ou nada: ou recebe todos os itens de uma vez, ou rejeita tudo e não recebe nenhum → Nunca fica incompleto. Se cair no meio, próxima tentativa recomeça do zero. Mais seguro, mas um pouco mais lento (uma transferência grande pode demorar mais pra processar).
- **Recomendação:** Fazer tudo ou nada. Sua transferência nunca fica pela metade, e o inventário fica consistente. Vale a diferença mínima de velocidade.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Recebimento de Estoque Transferido de Outro Galpão")

### D225 — Quando uma compra chega e é guardada na zona de embalagem com pedidos linkados, o sistema deve reunir esses pedidos automaticamente para embalar?
- [ ] **vou fazer** · fluxo: Guardagem de mercadoria recebida
- **Imagina assim:** Compra de fornecedor chega com 100 unidades. Na guarda, você marca para guardar na zona de embalagem. O sistema identifica 3 pedidos de clientes que estão esperando por essa mercadoria.
- **Hoje:** Após confirmar a guarda, o sistema verifica se a compra é cross-dock (pronta pra embarcar). Se sim e todos os itens da compra chegaram, ele dispara automaticamente a tarefa de reunir os pedidos para embalagem.
- **Por que importa:** Se isso não acontecer, pedidos ficam parados esperando mercadoria que já chegou. Atrasa o envio pro cliente.
- **Opções:** (A) Deixar como está: dispara automaticamente quando tudo da compra chega → Pedidos saem mais rápido (bom pro cliente), mas é automático — ninguém controla quando sai.  ·  (B) Exigir confirmação manual: alguém aprova antes de reunir os pedidos → Você tem controle total, mas precisa de mais uma ação. Pode travar se ninguém clicar.  ·  (C) Só dispara quando guardada na zona correta: não tira do automático, mas valida melhor → Mais seguro. Evita disparar pedidos se guardou em lugar errado.
- **Recomendação:** Deixe automático (opção 1). Pedidos que chegam prontos devem sair rápido. Monitore com relatório de cross-docks saídos por dia.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Guardagem de mercadoria recebida")

### D226 — O operador consegue separar e marcar um item que o departamento de compras já pegou?
- [ ] **vou fazer** · fluxo: Mandar item para compra quando não tem estoque no galpão
- **Imagina assim:** Um item virou uma compra com fornecedor (departamento de compras pegou). O operador na separação tenta marcar esse item como 'separado' no seu checklist. Deixa passar?
- **Hoje:** O item aparece no checklist da separação (o sistema mostra ele lá). Quando o operador tenta marcar como pronto, não temos 100% de certeza se o sistema bloqueia ou se deixa passar.
- **Por que importa:** Se deixar passar, o operador marca algo que o departamento de compras já está resolvendo — resultado: o mesmo item é processado duas vezes, estoque fica errado, caos.
- **Opções:** (A) O sistema não deixa marcar nada que tenha sido mandado pro fornecedor — bloqueia e mostra mensagem clara → Seguro: operador tenta clicar, sistema diz 'isso já está com compras'. Nunca duplica.  ·  (B) Nem mostra no checklist os itens que foram mandados pra compras → Simples: operador não vê, não tenta marcar. Cheklist fica só com o que de verdade pode separar.  ·  (C) Deixa passar: confia no operador não fazer besteira → Risco. Mas se treinamento for bom, pode funcionar.
- **Recomendação:** Fazer a opção 2: não mostrar no checklist itens que já foram mandados pra compras. É a mais simples e deixa a interface limpa. Operador só vê o que ele pode fazer.
- **➡️ MINHA ESCOLHA:** 
- **Código:** checklist/page.tsx:102-112 (isOcStatus), checklist-items query (não lido completo)

### D227 — Quando a internet cai enquanto o operador tira uma mercadoria — o sistema deve perguntar ao operador se quer tentar de novo automaticamente?
- [ ] **vou fazer** · fluxo: Embalagem de Compras de Fornecedor
- **Imagina assim:** Operador usa o scanner na embalagem, a rede da loja cai no meio do processo, o servidor responde com erro (504). O operador vê uma mensagem de erro na tela do scanner.
- **Hoje:** O sistema não tenta automaticamente de novo. A quantidade já foi atualizada no banco de dados, mas a tela do scanner mostra erro. O operador não sabe se aquele bip 'entrou' no sistema ou não.
- **Por que importa:** Se o operador clicar de novo porque acha que não funcionou, pode contar a mesma mercadoria duas vezes. O sistema detecta a confusão depois, mas gera retrabalho. Se o operador esperar sem fazer nada, o pedido fica parado.
- **Opções:** (A) Deixa como está: operador vê o erro e precisa checar manualmente no computador principal se o bip entrou → Risco de dupla contagem. Retrabalho. Operador fica inseguro se clica de novo ou não.  ·  (B) Scanner tenta automaticamente de novo (retry com alguns segundos de espera) → Se a rede volta, o bip entra sem o operador fazer nada. Se cair de novo mesmo depois de tentar, aí sim mostra o erro. Mais seguro, menos retrabalho.  ·  (C) Scanner mostra 'aguardando confirmação...' enquanto a rede está ruim, tenta discretamente nos bastidores → Operador vê que o sistema está 'pensando' e não clica de novo. Melhor experiência. Mais seguro.
- **Recomendação:** Escolha a opção 3. Assim o operador sabe que o sistema está tentando, não clica de novo, e se conseguir conectar de novo (internet volta), tudo funciona sozinho. Sem risco de duplo bip.
- **➡️ MINHA ESCOLHA:** 
- **Código:** bipar-embalagem-oc/route.ts:28,149-156

### D228 — Se o operador clica duas vezes rápido no botão 'Marcar como comprados', o que acontece?
- [ ] **vou fazer** · fluxo: Gestão de compras de fornecedor
- **Imagina assim:** Operador tem uma lista de 15 itens aguardando fornecedor. Clica no botão 'Marcar como comprados' (envia um pedido de compra pra todos). Acaba ficando com pressa, clica de novo no mesmo botão. Dois pedidos saem ao mesmo tempo.
- **Hoje:** Primeira clicada chega no sistema, marca os itens como 'comprados' (tira eles da fila de 'aguardando compra'). Segunda clicada chega, procura itens 'aguardando compra' de novo — não acha nada (porque primeira já virou 'comprados'). Segunda clicada retorna vazio ou erro. Operador vê aviso que deu ruim. Ninguém sabe se foi duplo clique ou se havia de verdade só um item pendente.
- **Por que importa:** Duplo clique é comum quando o app tá lento. Operador quer saber: 'meu duplo clique causou problema? Ou foi acidental e o sistema ignorou legal?'. Hoje é confuso, porque o erro é silencioso ou diz 'zero itens' — impossível saber qual foi a causa.
- **Opções:** (A) Desabilitar o botão após primeiro clique (enquanto processa): botão fica cinzento por 2 segundos. Impossível clicar de novo. → Mais fácil pra implementar. Usuário sabe que foi processado porque botão desapareceu.  ·  (B) Detectar duplo clique no sistema: se dois pedidos chegam muito perto, o segundo é ignorado silenciosamente. Ou retorna 'sucesso sem fazer nada'. → Sistema fica mais resiliente. Duplo clique não causa nada. Mas operador não sabe se foi duplo ou legítimo.  ·  (C) Token único de uma-só-execução: gera um ID único antes de enviar. Se o mesmo ID chegar 2x, ignora segunda. Tipo senha de uma-só-use. → Robusto demais. Difícil de implementar, mas totalmente à prova de duplo clique.
- **Recomendação:** Faça opção 1 (desabilitar botão) por enquanto — é rápida, clara, operador aprende em 5 minutos. Se houver problemas no futuro com requisições perdidas na internet, migre pra opção 3.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Gestão de compras de fornecedor")

### D229 — Se o sistema falha (servidor cai) no meio de processar 5 pedidos de uma vez, fica tudo travado?
- [ ] **vou fazer** · fluxo: Conclusão de pedido de compra após recebimento completo
- **Imagina assim:** Um operador confirma 5 pedidos pra conclusão. O sistema começa a marcar tudo como 'pronto' (primeiro pedido OK, segundo pedido OK, terceiro pedido — BAM, servidor cai).
- **Hoje:** Os primeiros 3 pedidos foram salvos como 'pronto'. Os últimos 2 ficam em 'aguardando'. Cliente vê 3 saindo e 2 travados. Ninguém sabe se repetem ou continuam.
- **Por que importa:** Se não tiver controle, o operador não sabe se pode reenviar ou vai duplicar. Pode mandar 2 pacotes pro mesmo cliente. Ou pode ficar item perdido no sistema.
- **Opções:** (A) Guardar um 'checkpoint': Sistema salva a cada pedido feito. Se cai, reinicia do próximo. Tipo um 'histórico de progresso'. → Continua de onde parou, sem repetição. Mais seguro. Precisa de um campo extra no banco.  ·  (B) Refazer tudo automaticamente se falhar: Sistema detecta que o comando falhou e repete sozinho. → Simples de entender. Mas precisa garantir que repetir não causa bagunça (ex: contar 2 vezes o estoque).  ·  (C) Fazer uma por uma com confirmação: Em vez de processar 5 de uma vez, processa 1, confirma, depois a próxima. → Mais lento, mas cada uma é isolada. Se cai em uma, as outras já tão salvas.
- **Recomendação:** Colocar tudo em 'tudo-ou-nada'. Se cair no meio, ignora tudo do que caiu e pode reenviar de novo sem duplicar. É a forma mais segura com menos mudança no código.
- **➡️ MINHA ESCOLHA:** 
- **Código:** /concluir-oc/route.ts:235-294

### D230 — Se 2 operadores clicam 'Concluir' no mesmo instante, um bota estoque dois vezes?
- [ ] **vou fazer** · fluxo: Conclusão de pedido de compra após recebimento completo
- **Imagina assim:** Operador A e Operador B ambos têm o pedido 1 aberto no depósito. A clica 'Concluir'. B clica 'Concluir' ao mesmo tempo (no mesmo segundo).
- **Hoje:** Banco de dados protege cada produto individualmente (cada item é independente). Se processar simultaneamente, o banco garante que cada um sai uma única vez (sem duplicação de saída de estoque).
- **Por que importa:** Evita contar o estoque 2 vezes (sair 2 de um item de 5 quando deveria sair só 1).
- **Opções:** (A) Fazer 'trava' no pedido: Quando A clica, pede acesso exclusivo — B fica bloqueado até A terminar. → 100% seguro, sem chance de duplicação. Mas mais lento: B tem que esperar.  ·  (B) Deixar como está: Banco já protege, não precisa fazer nada extra. → Rápido, seguro. Banco é confiável, não há duplicação. Simples.  ·  (C) Detectar duplicação depois: Se sair 2 vezes, sistema auto-corrige (entrada reversa). → Complicado. Melhor evitar desde o início.
- **Recomendação:** Deixar como está. O banco de dados já protege contra duplicação. Não precisa mudar nada. Se quiser ser extra-cautela, adiciona um 'check se já foi concluído' antes de processar — se já foi, avisa 'Este pedido já foi concluído' em vez de fazer denovo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** /concluir-oc/route.ts:167-185

### D231 — Quando o operador clica duas vezes no botão 'Registrar ajuste' muito rápido (ou por acidente), deve registrar uma ou duas operações?
- [ ] **vou fazer** · fluxo: Ajuste de estoque manual
- **Imagina assim:** Operador clica 'Registrar +100 kg' duas vezes rapidinho, porque a rede estava lenta ou por acidente do mouse
- **Hoje:** O botão fica desativado enquanto o sistema está processando, então em teoria a segunda tentativa não deveria chegar. Mas se a rede for muito lenta ou houver sincronismo errado, o sistema por trás recebe os dois comandos quase simultaneamente. O sistema não tem jeito de reconhecer 'ah, esses dois são o mesmo clique acidental' — então provavelmente registra duas operações de +100 kg cada uma, totalizando +200 kg indevidamente.
- **Por que importa:** Duplo clique acidental vira duplo ajuste. O inventário fica errado e ninguém sabe que aconteceu. No final do dia o estoque não bate.
- **Opções:** (A) Deixar como está → Duplo clique registra duas operações. Operador depois tem que manualmente localizar e desfazer uma delas.  ·  (B) Adicionar proteção: cada ajuste ganha um ID único baseado em quem fez, quando (até 1 segundo) e o que foi ajustado → Se dois cliques chegam juntos, o sistema reconhece 'é o mesmo clique duplicado' e só executa uma vez. Ou retorna o ID da operação anterior.  ·  (C) Impedir cliques duplicados apenas no lado da tela → Deixa o mesmo risco — alguém que conhece pode mandar dois comandos via ferramenta externa e consegue duplicar.
- **Recomendação:** Usar a proteção 'ID único do ajuste' no sistema por trás, não só na tela. Assim fica robusto contra acidentes e tentativas de burla.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/ajuste/page.tsx:54-78; src/lib/wms/movimentacoes.ts:431-453

### D232 — Se a internet cair ou o banco de dados falhar enquanto está registrando um ajuste de estoque, como o sistema deve se comportar?
- [ ] **vou fazer** · fluxo: Ajuste de estoque manual
- **Imagina assim:** Operador clica 'Registrar ajuste +50 peças' e a conexão com o banco de dados cai no meio do processo
- **Hoje:** O banco de dados desfaz automaticamente tudo (nenhuma peça é adicionada, nenhum registro fica sujo). O operador recebe uma mensagem de erro na tela. A tela mantém os dados que ele preencheu, então ele pode tentar novamente.
- **Por que importa:** Se a falha deixasse o banco em estado errado (ajuste parcial), o estoque ficaria inconsistente. Hoje está correto — falha = nada muda. Mas é importante confirmar que o operador consegue refazer sem risco de duplicação.
- **Opções:** (A) Deixar como está → Falha de rede = nada muda no banco. Operador refaz manualmente. Risco: se não houver proteção contra duplo clique, operador ao refazer pode duplicar sem saber.  ·  (B) Implementar proteção contra duplicação (ID único) junto com retry automático → Operador refaz, sistema reconhece 'é retry do mesmo ajuste' e operação é executada exatamente uma vez.
- **Recomendação:** Está funcionando bem na falha em si. Mas combine com a proteção contra duplo clique (decisão anterior) para deixar robusto também no retry.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:203-205; src/app/api/wms/ajuste/route.ts:105-112

### D233 — Duplo clique no 'Salvar' gera registro duplicado?
- [ ] **vou fazer** · fluxo: Reatribuição do responsável de uma venda
- **Imagina assim:** Operador seleciona novo vendedor, clica 'Salvar'. Rede lenta, aviso não aparece, operador clica de novo (duplo clique).
- **Hoje:** A tela desativa o botão durante o envio, então duplo clique normal não faz nada. MAS se a rede está muito lenta ou se o navegador recarrega, pode enviar duas vezes. Resultado: dois registros no histórico com os mesmos dados.
- **Por que importa:** Relatório fica com duplicata. Se está analisando eventos, vê um mesmo comando duas vezes no mesmo segundo. Confunde quem lê depois.
- **Opções:** (A) Deixar como está → Risco baixo, mas pode acontecer em rede ruim. Histórico pode ter duplicatas ocasionais.  ·  (B) Adicionar marca que evita repetir duas vezes (código único por submissão) → Mesmo que envie duas vezes, o sistema por tras detecta 'é o mesmo comando' e registra só uma vez. Histórico sempre correto.
- **Recomendação:** Implemente a marca que evita repetir — é investimento pequeno, evita confusão futura.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/vendas/[id]/vendedor/route.ts:1-117

### D234 — Se operador clicar 2 vezes por acaso no botão de executar realocação, antes da resposta chegar, manda 2 vezes ou bloqueia?
- [ ] **vou fazer** · fluxo: Mudança de estoque entre prateleiras (reabastecimento de picking)
- **Imagina assim:** Operador carrega 5 caixas pra mover de um lugar pro outro. Clica em 'Executar' e, antes de terminar, clica de novo por acaso.
- **Hoje:** Na tela, tem proteção — o botão fica desabilitado enquanto o sistema está processando. Se funcionar bem a tela, segundo clique é bloqueado. Mas se a tela falhar ou cair, os 2 cliques chegam no sistema como 2 pedidos diferentes. O sistema cria 2 pares de movimentações — dobra a quantidade, pode gerar reabastecimento duplo.
- **Por que importa:** Se um operador digita com pressa ou a conexão é ruim, pode colocar 10 caixas no lugar errado por acaso. Estoque fica com contagem errada de graça.
- **Opções:** (A) Deixar como está: confiar na tela em bloquear segundo clique → Simples, nenhuma mudança. Risco: se a tela falhar, entra duplicação. Mais raro, mas pode acontecer.  ·  (B) Sistema rejeita duplicação: associa um ID único pra cada clique, sistema rejeita o segundo com mesmo ID → Seguro: mesmo que a tela falhe, servidor bloqueia cópia. Precisa de mais código.
- **Recomendação:** Escolha a segunda. É a forma correta: não confiar só na tela. Protege contra qualquer tipo de erro de conexão ou clique acidental do operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/components/wms/ui/modals.tsx:1440-1443

### D235 — Quando existem dois tipos de pedido — alguns criados pelo seu sistema com números normais (123, 456) e outros criados por integração com marketplace/loja com código longo (UUID), o sistema ordena os pedidos alfabeticamente. Números e letras não ordenam do mesmo jeito. Deve mudar?
- [ ] **vou fazer** · fluxo: Detecção automática de saídas diretas do recebimento
- **Imagina assim:** Sua loja integrada com um marketplace cria pedido '4a2c5b8d-9e1f-44ca-8b6c-2a3d4e5f6g7h' no instante 09:50. Seu sistema manual cria pedido '000789' às 10:00. Na separação especial, o sistema processa primeiro o pedido com UUID (porque letra 'a' vem depois de '0' em alguns alfabetos), não o '000789' que chegou depois. Pedido mais antigo é separado por último.
- **Hoje:** O sistema ordena pedidos usando regra alfabética simples. Números da sua loja vêm antes, UUIDs do marketplace vêm depois — não é a ordem que chegaram.
- **Por que importa:** Não é 'primeiro que chegou, primeiro que sai'. Clientes da marketplace esperam mais do que deveriam. Seu pessoal separa na ordem errada, criando etapas ineficientes.
- **Opções:** (A) Deixar como está — a ordem não importa, desde que todos os pedidos sejam separados → Simples. Mas perde a vantagem de processar o mais antigo primeiro.  ·  (B) Guardar a hora/minuto em que cada pedido foi criado e ordenar por isso (independente do número) → Verdadeiro 'primeiro que chegou, primeiro que sai'. Mais justo com clientes. Um pouco mais de trabalho pra implementar.  ·  (C) Separar pedidos por tipo: primeiro os números da loja, depois os da marketplace (mantendo ordem dentro de cada grupo) → Previsível, mas ainda não é cronológico de verdade.
- **Recomendação:** Opção 2. É a mais justa. Você ganha eficiência (menos corridas entre prateleiras) e clientes mais satisfeitos. Vale o investimento.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Detecção automática de saídas diretas do recebimento")

### D236 — Sincronização em paralelo pode causar sobrescrita ou dados incompletos?
- [ ] **vou fazer** · fluxo: Sincronização de produtos com o Tiny
- **Imagina assim:** Seu sistema roda sincronização em lote com 20 produtos por vez. Se 2 processadores pegam o mesmo produto ao mesmo tempo, ambos tentam atualizar.
- **Hoje:** Banco de dados faz última-escrita-vence — última atualização vence, sobrescreve a anterior. Se processador 1 diz 'produto_A com preço 100' e processador 2 diz 'produto_A com preço 105' quase ao mesmo tempo, fica 105 (ou 100, depende de quem terminou por último). Também podem criar 2 entradas de fornecedor em situação rara.
- **Por que importa:** Você perde dados ou fica com inconsistência sem saber. Preço fica errado, estoque fica errado. Se isso acontecer com 1000 produtos por noite, você não descobre até cliente reclamar.
- **Opções:** (A) Deixar como está (sem proteção) → Risco de sobrescrita silenciosa. Chance baixa (duas acoes no mesmo instante, uma pisando na outra rara) mas catastrófica quando acontece.  ·  (B) Adicionar trava — bloquear produto enquanto atualiza, outros processadores aguardam → Mais lento (processado um por um) mas garantido consistente. Típico em bancos.  ·  (C) Rodar sincronização em série (1 produto por vez, não em paralelo) → Mais lento mas 100% seguro. Se 1000 produtos demora 10min, fica 5min. Aceitável.
- **Recomendação:** Adicionar trava ou rodar em série. Nunca deixe duas acoes no mesmo instante, uma pisando na outra silenciosa.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sincronização de produtos com o Tiny")

### D237 — Duplo clique em botão 'Receber' — o sistema aceita o segundo comando?
- [ ] **vou fazer** · fluxo: Consulta do saldo de estoque — quanto tem e onde tem
- **Imagina assim:** Operador recebe 50 unidades de produto ABC, clica botão, insere quantidade, a internet demora, clica de novo. Sistema recebe dois comandos idênticos quase no mesmo instante.
- **Hoje:** Sistema processa ambos os cliques como movimentações válidas. Estoque sobe de 0 para 100 em vez de 50. Banco aceita os dois inserts porque cada um é individualmente correto.
- **Por que importa:** Inventário fica errado. Pedidos que deveriam ficar bloqueados (esperando mercadoria) ganham saldo fictício. Roteamento de picking manda separador pra prateleira que não tem mercadoria. Retrabalho, devoluções, cliente insatisfeito.
- **Opções:** (A) Sistema reconhece o segundo clique como repetição (mesmo operador, mesma prateleira, dentro de 30 segundos) e descarta — estoque vira 50 apenas uma vez. → Proteção automática. Operador não precisa se preocupar com duplo clique. Seguro.  ·  (B) Desabilitar o botão após primeiro clique até o servidor responder — operador espera. → Mais lento, mas impossível duplicar. Ruim se internet está muito lenta.
- **Recomendação:** Implementar a primeira opção. Sistema inteligente que descarta duplicado. Melhor experiência e segurança.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ledger.ts:164-175, rpc_inserir_movimentacao.sql:77-105

### D238 — Quando mercadoria chega bloqueada num pedido — o sistema avisa que pode processar, e se a tarefa automática falhar, você descobre?
- [ ] **vou fazer** · fluxo: Consulta do saldo de estoque — quanto tem e onde tem
- **Imagina assim:** Pedido P001 está esperando 100 unidades de ABC para sair (travado, na fila). Você recebe 100 unidades de ABC do fornecedor. Sistema detecta e marca o pedido como 'pode processar agora'. Mas você não vê aviso visual.
- **Hoje:** Rotina automática roda em segundo plano (não bloqueia o recebimento). Marca pedido com flag 'novo saldo apareceu'. Se a rotina falhar silenciosamente, ninguém avisa — você só descobre quando pergunta 'por que esse pedido não saiu?'.
- **Por que importa:** Pedidos ficam presos invisíveis. Seu prazo de entrega dispara. Cliente reclama. Você pensa que é culpa do separador, quando na verdade o sistema nunca mandou o sinal de 'pode começar'.
- **Opções:** (A) Adicionar notificação visual (banner, email) quando a rotina marca o pedido como 'pronto' — você sabe que saiu do travamento. → Transparência. Você vê quando coisa acontece.  ·  (B) Adicionar log claro quando a rotina falha — você consegue ver no histórico 'rotina falhou em tal hora pro pedido tal'. → Rastreabilidade. Se algo der errado, você debugga.  ·  (C) Deixar como está (sem notificação, sem log de falha). → Silencioso. Risco de pedido preso sem você saber.
- **Recomendação:** Implementar primeira e segunda opções juntas. Notificação = você sabe que saiu do travamento. Log de falha = você descobre rápido se der problema. Ambas são baratas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ledger.ts:234-262, varredura-validacao-oc.ts, reconciliador-oc.ts

### D239 — Quanto tempo uma pendência pode ficar parada antes de expirar ou virar aviso?
- [ ] **vou fazer** · fluxo: Painel de Tarefas da Guarda
- **Imagina assim:** Pendência de guarda foi criada em 2026-05-20 (segunda-feira). Agora é 2026-05-27 (segunda-feira seguinte). Ninguém tocou. Operador pega na fila e começa a guardar. Sistema permite — não há bloqueio de idade.
- **Hoje:** Sistema NÃO expira pendências antigas. Se foi criada há 7 dias e ninguém guardou, fica lá até guardar ou cancelar manualmente. Não há contador de dias ou aviso de idade.
- **Por que importa:** Se a mercadoria chegou há uma semana e ainda tá esperando guarda, pode ser risco: produto pode ter movido (outro pedido, ajuste de saldo), estoque pode ter mudado. Pode ir guardando quantidade errada sem saber. Ou pendência foi criada por engano e ninguém reparou — vira bagunça no estoque.
- **Opções:** (A) Deixar como está: pendências não expiram, são guardadas sempre quando o operador chegar → Flexível, sem surpresas de cancelamento automático. Mas acumula pendências muito antigas que ninguém lembrou de cancelar.  ·  (B) Sistema cancela automaticamente após 7 dias não-guardados → Limpa backlog antigo. Risco: pode cancelar uma pendência legítima que tava esperando material chegar. Operador precisa recriar.  ·  (C) Sistema avisa (amarelo/vermelho) depois de 3 dias não-guardados, operador confirma ou cancela → Força decisão. Clareia a fila de itens esquecidos. Mais trabalho manual pra confirmar.
- **Recomendação:** Use a opção 3 (aviso após 3 dias). Senão você acumula pendências zumbi. Depois de 3 dias parado, o sistema marca vermelho na fila ('Atenção: 3 dias parado') e força o operador a falar 'continua' ou 'cancela'. Sem isso, daqui a um mês há 200 pendências antigas ninguém mexeu.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/guarda.ts:434-506

### D240 — Quando uma regra de alerta falha seguidamente, o que fazer? Desativar automaticamente ou insistir tentando?
- [ ] **vou fazer** · fluxo: Sistema de Alertas e Sinais de Anomalia
- **Imagina assim:** Você criou uma regra para avisar quando o andamento dos pedidos cai. Do nada, a base de dados que alimenta essa regra é deletada por engano. No dia seguinte, o sistema tenta rodar a regra 3 vezes e falha todas. Ninguém repara.
- **Hoje:** Depois de 3 falhas seguidas, o sistema automaticamente desativa a regra e para de tentar. Você vê no painel que a regra está desativada e a última execução foi erro.
- **Por que importa:** Duas vias opostas: uma é segura (desativa e espera você arrumar), outra é resiliente (continua tentando até funcionar, mas pode encher sua caixa de mensagens de alarmes falsos).
- **Opções:** (A) Desativar automaticamente ("fail closed" — seguro e silencioso) → A regra para de rodar, o sistema não gera mais avisos falsos, mas você precisa perceber que desativou e reativar na mão quando arrumar o problema.  ·  (B) Continuar tentando infinitamente ("fail open" — resiliente, mas ruidoso) → O sistema não desiste nunca, mas você pode receber 100 notificações de erro antes de perceber que a regra virou um problema.  ·  (C) Desativar APÓS mandar alerta (meio-termo) → Sistema tenta 3 vezes, falha 3, manda 1 alerta pra você, depois desativa. Você sabe que algo quebrou.
- **Recomendação:** Desativar após mandar alerta. Assim você fica ciente sem ser bombardeado de mensagens, e sabe exatamente qual regra quebrou.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Sistema de Alertas e Sinais de Anomalia")

### D241 — Qual o tempo máximo aceitável para um administrador editar uma empresa e todos os computadores verem a mudança?
- [ ] **vou fazer** · fluxo: Controle de Empresas, Filiais e Galpões
- **Imagina assim:** Admin 1 (no computador da loja em CWB) edita NetAir e muda o galpão preferencial. Ao mesmo tempo, Admin 2 (no escritório em SP) tira uma lista de empresas e preferenciais no seu navegador. Pergunta: quando Admin 2 vai ver que NetAir agora é SP, não mais CWB?
- **Hoje:** Se os dois computadores estão em servidores diferentes, Admin 2 pode ver a informação antiga por até 5 minutos. Isso porque cada servidor guarda uma cópia e demora 5 minutos pra esquecer.
- **Por que importa:** Se um admin vê informação desatualizada, pode tomar decisão errada. Exemplo: acredita que NetAir está em CWB, mas já é SP. Ou transferências de estoque pra galpão errado.
- **Opções:** (A) Manter o que tem agora (informação antiga por até 5 min). Rápido, mas pode ficar desatualizado. → Bom pra performance, ruim pra consistência. Admin vê informação antiga por até 5 min.  ·  (B) Reduzir tempo pra 30 segundos. Menos diferença, mas um pouco mais lento. → Melhor consistência. Ainda rápido. Compromisso razoável.  ·  (C) Usar memória compartilhada entre servidores. Quando um servidor atualiza, todos esquecem junto. → Melhor solução. Tão rápido quanto antes, mas tudo vê a mesma coisa ao mesmo tempo.  ·  (D) Sem guarda de cópia. Toda requisição vai ao banco de dados. → Sempre atualizado. Muito mais lento. Não vale a pena.
- **Recomendação:** Implementar memória compartilhada entre servidores. Se não for possível agora, reduzir o tempo de guarda local pra 30 segundos como mínimo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** empresa-lookup.ts:23-24, 137-140

### D242 — Gerente clica 'Testar' em 3 contas de impressora rapidamente, uma após outra. O sistema consegue lidar com testes em paralelo?
- [ ] **vou fazer** · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Gerente tem 3 contas de impressora configuradas (Conta A, B, C). Clica 'Testar' em cada uma em sequência rápida (em menos de 1 segundo), sem esperar a resposta de uma antes de clicar a próxima.
- **Hoje:** O sistema permite múltiplos testes em paralelo. Cada teste mantém seu próprio resultado no sistema (não interfere um com o outro). Gerente vê 'OK' ou 'FALHA' para cada conta de forma independente.
- **Por que importa:** Gerente quer testar rápido para confirmar que as 3 contas funcionam. Se os testes se pisassem, resultado de um afetaria o outro, e gerente não saberia qual conta realmente funciona.
- **Opções:** (A) Deixar como está (cada teste é independente) → Gerente clica rapidamente em 3 testes e vê resultado claro de cada uma. Funciona bem.  ·  (B) Bloquear os testes para rodar um por vez (com fila) → Gerente clica 3 vezes, mas teste 2 e 3 esperam o teste 1 terminar. Mais lento, mas evita qualquer confusão.
- **Recomendação:** Deixe como está. Os testes já são independentes e funcionam bem em paralelo.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/wms/configuracoes/conexoes/page.tsx:1473-1490

### D243 — Quando operador clica 'Reimprimir etiqueta' e a etiqueta já estava cacheada, o sistema consegue garantir que não vai fazer a mesma coisa duas vezes se operador clicar 2 vezes no mesmo instante?
- [ ] **vou fazer** · fluxo: Gestão de impressoras na retaguarda
- **Imagina assim:** Operador vê um pedido separado. Clica 'Reimprimir etiqueta' para imprimir a nota fiscal + etiqueta de envio. A impressora está lenta. Operador fica nervoso e clica 'Reimprimir' novamente (ao mesmo tempo que o primeiro clique ainda está processando).
- **Hoje:** O sistema usa um 'travamento' para garantir que só uma solicitação consegue marcar a etiqueta como 'impresso'. Se vem 2 cliques simultâneos, um ganha e marca 'impresso', o outro tenta marcar e falha silenciosamente (ou retorna erro). Próximas impressões só usam a cacheada.
- **Por que importa:** Se o sistema não tivesse este travamento, 2 cliques simultâneos poderiam imprimir a etiqueta 2 vezes. Ou marcar como 'impresso' duas vezes, causando confusão no histórico.
- **Opções:** (A) Manter o travamento (comportamento de hoje) → Operador clica 2 vezes e apenas 1 impressão sai. Sistema trata como 1 trabalho. Correto.  ·  (B) Remover o travamento → 2 cliques = 2 impressões. Papel desperdiçado e histórico confuso. Ruim.
- **Recomendação:** Mantenha o travamento. Está funcionando bem e evita impressões duplicadas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/etiqueta-service.ts:118-125

### D244 — Quando um operador clica 'Reimprimir' duas vezes muito rápido no mesmo rótulo, o sistema imprime duas cópias em vez de uma — como evitar isso?
- [ ] **vou fazer** · fluxo: Reimpressão de etiqueta quando falha
- **Imagina assim:** Log id=abc123 com status 'erro'. Operador clica botão Reimprimir 2x em rápida sucessão (ou de navegadores diferentes ao mesmo tempo). Dois pedidos chegam ao sistema simultaneamente, ambos leem que o status é 'erro', ambos enviam para a impressora, ambos marcam como 'sucesso'. PrintNode processa os dois — resultado: 2 cópias do mesmo rótulo saem pela impressora.
- **Hoje:** O sistema faz o segundo clique normalmente, sem nenhuma proteção. Ambos os cliques processam como se fossem válidos.
- **Por que importa:** Dois rótulos iguais causam confusão no galpão, podem gerar erros na embalagem, desperdício de papel, e o operador fica sem saber o que aconteceu.
- **Opções:** (A) Bloquear o botão de Reimprimir enquanto o sistema processa (desabilita por alguns segundos) → Operador não consegue clicar 2x. Simples, mas se o sistema ficar lento, parece travado.  ·  (B) Sistema rejeita o segundo clique automaticamente — se o status mudou de 'erro' para 'sucesso' entre o 1º e 2º clique, retorna 'já foi feito' → Protege contra acidentes, mas operador pode se assustar com mensagem de erro.  ·  (C) Criar um botão separado 'Reimprimir' (diferente de 'Retry') — só funciona em rótulos já 'sucesso' → Deixa clara a intenção (nova tentativa vs reimpressão). Mais cuidado, menos acidentes.
- **Recomendação:** Opção 2 é a mais segura — rejeita o segundo clique se já foi processado. Mas mostre mensagem amigável: 'Este rótulo já foi reenviado com sucesso em 14:30'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** retry/route.ts:43-45, retry/route.ts:80-88

### D245 — A fila de tarefas pode ficar tão grande que trava tudo?
- [ ] **vou fazer** · fluxo: Processamento automático de pedidos aprovados
- **Imagina assim:** Sistema tem 10 mil tarefas esperando (por exemplo, porque o Tiny está lento respondendo). Novos pedidos continuam sendo aprovados, enfileirando mais tarefas. Fila só cresce.
- **Hoje:** Cada aprovação coloca a tarefa na fila sem perguntar. Sistema processa em lotes de 20 tarefas. Sem limite, a fila pode crescer infinitamente.
- **Por que importa:** Memória do servidor enche. Banco de dados fica lento processando bilhões de registros. Sistema inteiro desacelera ou cai.
- **Opções:** (A) Congelar novos pedidos quando fila está grande (ex: >1000 tarefas) → Sistema avisa ao usuário: 'fila cheia, tente aprovar depois'. Protege a infraestrutura.  ·  (B) Aumentar velocidade de processamento (melhorar banco, tarefa que roda sozinha em segundo plano threads) → Fila nunca explode porque drena mais rápido. Custo, mas robusto.  ·  (C) Deixar como está → Eventualmente sistema falha quando fila fica muito grande. Sem proteção.
- **Recomendação:** Implementar limite na fila. Quando passar de 1000 tarefas pendentes, avisa ao operador. Depois rediscute se quer aumentar tarefas que rodam em segundo plano ou limite de aprovações.
- **➡️ MINHA ESCOLHA:** 
- **Código:** execution-worker.ts:112-274


## Tema: Estoque apartado pros pedidos (reservas) (16)

### D246 — Quanto tempo uma mercadoria pode ficar apartada esperando por um pedido que não avança?
- [ ] **vou fazer** · fluxo: Roteamento automático de pedidos
- **Imagina assim:** Pedido 2045 foi aprovado em 02/06. O sistema apartou 15 unidades de um produto. Mas o operador nunca pegou no estoque pra separar. Chega 30 dias depois e a mercadoria está lá, parada, não pode mais vender pra ninguém.
- **Hoje:** O sistema deixa em 30 dias (padrão). Aí uma rotina automática no fundo da noite limpa isso e devolve os 15 para o monte livre. Mas o pedido fica travado.
- **Por que importa:** Toda hora que mercadoria fica apartada é grana parada que não circula. Se um pedido morre mas a mercadoria continua reservada, é como ter dinheiro escondido na gaveta.
- **Opções:** (A) Manter em 30 dias (hoje) → Mais tempo pro operador não dar conta. Mercadoria mais tempo parada.  ·  (B) Reduzir pra 7 dias (uma semana) → Força velocidade. Pedidos vagarosos liberam mais cedo. Mercadoria volta mais rápido pra venda.  ·  (C) Reduzir pra 2 dias → Muito apertado. Pedidos legítimos podem perder mercadoria se tiver qualquer atraso operacional.
- **Recomendação:** Mudar pra 7 dias. É o tempo normal de uma semana de trabalho. Dá tempo pro operador separar pedidos normais, mas não deixa mercadoria travada demais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reservas.ts:6-10

### D247 — Quando um pedido é cancelado e depois aprovado novamente, o sistema cria novas reservas ou reutiliza as antigas?
- [ ] **vou fazer** · fluxo: Aprovação de Pedidos e Compras
- **Imagina assim:** #222: operador aprova (apartou 5 unidades do sku_a). Depois admin cancela tudo e devuelve o estoque apartado pro monte. Depois um dia depois, operador aprova o mesmo pedido outra vez.
- **Hoje:** O sistema verifica se já existe um apartamento antigo daquele pedido. Acha a reserva antiga (que já foi dada de volta) e não cria uma nova. Segue sem apartamento.
- **Por que importa:** Na segunda aprovação, você pensa que apartou as mercadorias, mas o sistema pulou essa etapa. A retaguarda procura as 5 unidades numa prateleira que o sistema não marcou, vai dar confusão.
- **Opções:** (A) Criar novas reservas sempre que aprovar, ignorando as antigas. → Simples de entender. Mas se alguém aprovar 10 vezes por acidente, cria 10 apartamentos diferentes, mais confusão.  ·  (B) Verificar se a reserva antiga ainda está em pé. Se foi devolvida, criar uma nova. Se ainda está apartada, não faz nada. → Mais correto. Respeita histórico, mas precisa de lógica extra pra validar se a devolução foi de verdade.  ·  (C) Avisar o operador que já houve um apartamento anterior e pedir confirmação pra refazer. → Manual e seguro, mas pede clique extra.
- **Recomendação:** Use a opção 2. Seu sistema já tem registro de quem devolveu o apartamento. Antes de criar uma nova reserva, confirme que a devolução foi mesmo registrada. Se foi, cria nova. Se não foi, avisa o operador que tem uma reserva órfã flutuando.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/aprovar/route.ts:442-492

### D248 — Quando a mercadoria chega, o sistema deve automaticamente liberar estoque preso em pedidos que estão esperando há tempo?
- [ ] **vou fazer** · fluxo: Guardagem de mercadoria recebida
- **Imagina assim:** Dois pedidos estão presos porque faltava estoque. Chega uma compra com 500 unidades. Você guarda tudo. O sistema tem 2 pedidos em 'validação de compra' esperando.
- **Hoje:** Após confirmar a guarda, o sistema faz uma varredura nos pedidos travados. Calcula quanto estoque está livre agora (o total menos o já reservado). Marca como 'liberado' os pedidos que agora cabem no estoque disponível, começando pelos mais antigos.
- **Por que importa:** Se não fizer isso, pedido fica parado esperando mercadoria que já chegou. Atrasa entrega, cliente reclama.
- **Opções:** (A) Deixar automático: sempre que chega mercadoria, libera os pedidos que agora cabem → Tudo flui naturalmente. Nenhum pedido fica prisioneiro de mercadoria que já chegou.  ·  (B) Manual: você revisa e aprova liberação de cada pedido → Controle total, mas mais lento. Pra cada compra, você aprova 1 a 1.  ·  (C) Liberar só pedidos com prazo curto (mais de X dias parado) → Prioriza urgentes, mas pode deixar outros esperando.
- **Recomendação:** Automático (opção 1). Mercadoria que chegou deve fluir pro pedido mais rápido possível. Configure a varredura pra rodar logo após guardar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Guardagem de mercadoria recebida")

### D249 — Quando faltam unidades e a gente realoca de outro lugar, o que faz com o pedaço que não achou?
- [ ] **vou fazer** · fluxo: Mandar item para compra quando não tem estoque no galpão
- **Imagina assim:** Um item precisa de 5 unidades. Tem 3 em outra prateleira — a gente realoca. Mas faltam 2. O sistema manda esses 2 pra compra? Ou cria uma realocação incompleta? Ou faz os dois?
- **Hoje:** O sistema tenta fazer os dois: realoca as 3 unidades que achou, e manda as 2 que faltam pro fornecedor automaticamente. Tudo em um clique. Mas não está 100% claro se um mesmo item pode ter ao mesmo tempo uma realocação E uma compra pendente.
- **Por que importa:** Pra saber se o sistema está fazendo o certo. Se um item virar dois pedaços (um realocado, outro pra compra), é completo e seguro. Se ficar confuso, o estoque erra.
- **Opções:** (A) Deixar como está: sistema faz os dois automaticamente. Realoca o que achou, manda pra compra o que faltou. → Automático, sem operador pensar. Mas precisa testar bem se funciona mesmo.  ·  (B) Só realoca o que achou. O que falta, o operador decide depois se manda pra compra ou não → Menos automático, mas mais controle. Operador vê: 'achei 3, faltam 2, e aí?'  ·  (C) Só manda pra compra se conseguir realocação 100%. Senão, deixa o item como estava → Conservador: só age se resolve tudo de uma vez.
- **Recomendação:** Ir com a opção 1 (automático). Mas antes disso, fazer um teste completo com números reais pra garantir que o item fica bem estruturado nos dois lados (3 unidades realocadas, 2 em compra). Depois documenta pra galera como funciona.
- **➡️ MINHA ESCOLHA:** 
- **Código:** parcial/route.ts:1137-1145 (lógica mista), mandar-compras.ts (não distingue se é residual ou total)

### D250 — Quando o sistema fica entre duas tarefas — ele prende a mercadoria apartada mesmo que a próxima etapa falhe?
- [ ] **vou fazer** · fluxo: Mandar um pedido para outro galpão
- **Imagina assim:** Um pedido está separando. O operador clica em 'enviar pro outro galpão'. O sistema pronta 3 vezes apartando a mercadoria de volta pro estoque geral. Mas na última parte, a gravação do pedido (registro do movimento) falha por timeout.
- **Hoje:** O sistema pronta a mercadoria mas não registra tudo. O pedido fica preso: diz que tem mercadoria ainda apartada, mas na verdade 3 itens já voltaram pro monte.
- **Por que importa:** Se o sistema soltar a mercadoria (pronta de verdade) mas não registra que soltou, o operador fica cego. Pode separar a mesma caixa duas vezes. Pode vender pra dois clientes. Fica caótico.
- **Opções:** (A) Fazer a ação em um único bloco: apronta E registra juntos. Se uma falha, volta tudo. → Seguro: ou faz tudo ou não faz nada. Sem ficção de mercadoria apartada.  ·  (B) Sistema tenta de novo: se falhar uma vez, tenta mais 5 minutos. → Pode funcionar se o timeout é momentâneo. Risco: perde tempo enquanto operador espera.  ·  (C) Marcar o pedido como 'alerta de problema' pro operador revisar. → Operador sabe que algo deu errado, pode arrumar manualmente. Seguro mas exige trabalho extra.
- **Recomendação:** Opção 1 (ação em bloco). Hoje qualquer perda de conexão deixa o sistema mentindo sobre o estoque — isso é crítico. Implementem a ação como uma transação: apronta + registra + sucesso / nada aconteceu.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:149-187, reservas.ts:170-184

### D251 — Quando alguém retira estoque de uma prateleira rapidinho (outro pedido, outro operador), a contagem ainda vale?
- [ ] **vou fazer** · fluxo: Verificação de Estoque na Hora da Separação
- **Imagina assim:** Um operador conta 8 unidades na prateleira A-06-01. O saldo fica 8. Nos 10 segundos seguintes, outro pedido chega e puxa 5 unidades daquela prateleira. Agora tem 3 sobrando. Quando o primeiro operador tenta separar o pedido dele (que precisava de 5), encontra só 3.
- **Hoje:** O sistema registra a contagem (+8) como um ganho no saldo, mas não bloqueia a prateleira. Outros pedidos podem mexer no estoque livremente. A contagem vale como verdade, mas o saldo que ela criou já foi consumido por outro antes que o operador pudesse usar.
- **Por que importa:** Seu operador confiou no saldo que viu e tentou separar um pedido que já não tem estoque. Precisa ligar pro cliente avisando que o estoque sumiu, ou esperar chegar mais mercadoria. Pode gerar reclamações de clientes e atraso de entregas.
- **Opções:** (A) Deixar como está (sem bloquear; risco de falta após contagem) → Simples. Operadores precisam conferir de novo antes de separar, ou enfrentam surpresa de falta.  ·  (B) Bloquear a prateleira durante e logo após a contagem (segundos ou minutos) → Outro operador espera um pouco. Garante que a contagem e a separação saem juntas. Mais robusto.
- **Recomendação:** Bloqueia por alguns segundos/minutos. Custa pouco em agilidade e dá segurança ao seu operador. Vale a pena.
- **➡️ MINHA ESCOLHA:** 
- **Código:** contagem-inline.ts:99-129, inventario.ts:660-924

### D252 — Estoque apartado para um pedido 'esquecido' na separação por 35 dias — como garantir que ele volta ao saldo?
- [ ] **vou fazer** · fluxo: Criar uma venda na mão
- **Imagina assim:** Um pedido em modo 'separação' foi criado 35 dias atrás. O estoque foi apartado (separado da prateleira, bloqueado para outras vendas). Ninguém terminou a separação, ninguém cancelou. Hoje, aquele estoque continua apartado e indisponível para vender, mesmo que a venda original tenha morrido.
- **Hoje:** O sistema tem regra: apartado por máximo 30 dias. Depois disso, deveria limpar automaticamente (uma tarefa que roda sozinha em segundo plano verifica 1x por hora e remove o apartado expirado). Mas não confirmei se essa tarefa está funcionando, ou se é só um plano.
- **Por que importa:** Se o apartado fica travado indefinidamente, o saldo do galpão fica errado — parece que não tem estoque quando na verdade tem, está só esquecido. Operador tenta vender, sistema diz que não tem, cliente não consegue comprar, venda é perdida.
- **Opções:** (A) Ativar a limpeza automática: tarefa que roda sozinha em segundo plano a cada 1 hora remove apartado expirado → Após 30 dias, o apartado é automaticamente devolvido ao saldo. Saldo fica correto, sem intervenção manual. Pedido continua registrado (não apaga), mas o estoque volta a estar disponível.  ·  (B) Deixar manual: operador ou gerente tem que cancelar o pedido antigo → Precisa de atenção. Se ninguém cancelar, o estoque fica perdido para sempre. Operação mais trabalhosa.
- **Recomendação:** Ativar a limpeza automática. Depois de 30 dias, o apartado deve ir embora sozinho — é automatismo. Assim o saldo nunca fica travado indefinidamente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:470

### D253 — Quando aprovar uma venda, como garantir que o estoque não foi reservado duas vezes?
- [ ] **vou fazer** · fluxo: Separação de Pedidos (operador marca itens conforme apanha do galpão)
- **Imagina assim:** Operador aprova uma venda manual com 5 unidades do produto A. Sistema verifica se tem 5 de saldo livre
- **Hoje:** Sistema separa (reserva) essas 5 unidades do produto A pra esse pedido específico. Ninguém mais consegue vender aquelas 5. Mas se dois operadores clicam em Aprovar ao mesmo tempo, pode separar duas vezes.
- **Por que importa:** Se reservar duas vezes, o saldo muda duas vezes. Saldo = 10, primeira reserva: saldo = 5 (reservado = 5). Se tiver uma segunda aprovação, tenta reservar de novo: saldo ficaria 0 (reservado = 10). Mas não tem 10 unidades — tem 5. Sistema fica inconsistente, e você não consegue vender.
- **Opções:** (A) Sistema bloqueia a prateleira durante a aprovação: dois operadores não conseguem aprovar ao mesmo tempo → Seguro, mas se um operador demora muito (conexão lenta), o outro espera travado. Pode ficar lento.  ·  (B) Sistema verifica no último segundo: 'ainda tem saldo?' Se não, recusa com erro 409: 'alguém foi mais rápido' → Rápido. Se perder a corrida, operador tenta de novo. Mais ágil para o dia a dia.
- **Recomendação:** Escolher opção 2. Rápido e seguro. Quando aprova, sistema verifica saldo naquele exato instante. Se alguém foi mais rápido e já pegou aquele estoque, recusa com 'sem saldo' e operador tenta novamente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/pedidos/aprovar/route.ts:145-180

### D254 — Estoque apartado de uma venda que foi abandonada: quanto tempo espera antes de devolver pra prateleira?
- [ ] **vou fazer** · fluxo: Venda Manual (consulta de estoque + criação de pedido)
- **Imagina assim:** Vendedor cria uma venda manual com 3 unidades de um produto apartadas na prateleira 1 (estoque reservado). Depois ia separar, mas foi embora (café, saiu cedo, esqueceu). 40 dias depois, ninguém separou, ninguém cancelou — simplesmente deixou lá.
- **Hoje:** O sistema tem uma tarefa automática que roda periodicamente (cada 1 hora, assumidamente) procurando estoque apartado que tá vencido. Quando acha, devolve as 3 unidades pra prateleira 1 automaticamente. Ninguém precisa fazer nada.
- **Por que importa:** Se deixa apartado pra sempre, você vende 3 unidades que não existem (no papel). Cliente pede, você promete, depois descobre que tá apartado em uma venda morta. Seu saldo virtual fica errado.
- **Opções:** (A) Deixar como está: 30 dias de prazo → Estoque volta sozinho depois de 1 mês; se a venda é rápida (< 1 mês), tudo bem  ·  (B) Aumentar prazo pra 60 dias → Mais tempo pra separador; mais risco de venda morta comendo estoque virtual  ·  (C) Diminuir pra 7 dias (uma semana) → Volta rápido; separador tem que ser rápido senão perde o estoque  ·  (D) Avisar no painel: 'Estoque vencendo em 5 dias' (aviso manual 2x por semana) → Admin vê, cancela venda morta ou manda separador rápido
- **Recomendação:** Use a opção 4: 30 dias tá bom, mas coloca um aviso visual no painel quando faltam 5 dias. Vendedor/admin vê e toma decisão (cancela ou apressa separação). Sem aviso, é caixa preta.
- **➡️ MINHA ESCOLHA:** 
- **Código:** reservas.ts:cleanupReservasExpiradas

### D255 — Quando o estoque apartado pro pedido vence (mais de 30 dias esperando a Nota Fiscal), o que fazer?
- [ ] **vou fazer** · fluxo: Quando estoque chega, ligar de novo os pedidos presos esperando compra
- **Imagina assim:** O Pedido 1 foi liberado pela compra (todos itens recebidos). O sistema apartou 5 unidades de uma SKU em uma prateleira, marcando que expira em 30 dias. Passam-se 31 dias. A Nota Fiscal nunca chegou e o operador esqueceu do pedido.
- **Hoje:** Sistema limpa automaticamente o estoque apartado (dele volta pro montão disponível). O pedido fica sem o estoque reservado, expostos a outros pedidos.
- **Por que importa:** Se o operador encontrou a mercadoria e o pedido estava legal, mas só demora pra chegar a NF, perder a reserva significa precisar procurar de novo em 2 semanas quando achar o documento. Se a mercadoria foi despachada pra loja errada, o apartado foi inútil mesmo.
- **Opções:** (A) 1. Deixar como está (limpar o apartado em 30 dias sempre) → Pedidos antigos perdem automaticamente a reserva. Operador descobre quando a NF chega e não tem estoque.  ·  (B) 2. Estender para 60 dias (dar mais tempo esperando a NF) → Risco de deixar estoque 'morto' por 2 meses. Mais tempo pra operador encontrar a NF, mas pode virar nunca.  ·  (C) 3. Avisador: 3 dias antes de vencer, enviar notificação ao operador → Operador pode 'renovar' manualmente a reserva se ainda está esperando. Evita limpeza por surpresa.  ·  (D) 4. Manter de pé mas marcar como 'expirado' (não contar no disponível, mas não limpar de verdade) → Estoque fica 'fantasma' — conta como indisponível, não pode vender, mas ainda está lá fisicamente. Confunde os números.
- **Recomendação:** Opção 3: avisar o operador com 3 dias de antecedência. Assim ele pode renovar se a NF está chegando, ou confirmar que quer perder o apartado. Evita surpresas e decisões automáticas que podem estar erradas.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reservas.ts:6-10

### D256 — Dois operadores recebem ao mesmo tempo partes diferentes de um mesmo pedido de fornecedor (ex: 5 unidades cada de SKU que o pedido precisa de 10). Qual chega primeiro no apartado?
- [ ] **vou fazer** · fluxo: Quando estoque chega, ligar de novo os pedidos presos esperando compra
- **Imagina assim:** Pedido 1 precisa de 10 Parafusos M10 (5 para separação A, 5 para separação B). Operador 1 confirma recebimento de 5 unidades. Operador 2 confirma recebimento de mais 5 unidades — tudo ao mesmo tempo (menos de 1 segundo de diferença).
- **Hoje:** Ambas receitas são processadas em paralelo pelo sistema. Primeira cria apartado de 5 pra um lado, segunda cria apartado de 5 pro outro. Se houver ordem (FIFO por prateleira ou por item), segue a sequência. Se não houver ordem clara, pode virar 'competição' pra saber qual reserva sai primeiro.
- **Por que importa:** Pedido só sai da etapa quando TODAS as partes chegam. Se uma chega antes da outra e o sistema começa a separar do apartado errado, pode causar falta depois. Ordem importa quando há lógica de prioridade (qual prateleira pega antes).
- **Opções:** (A) 1. Deixar como está (processamento em paralelo, ordem indeterminada) → Funciona na maioria dos casos, mas se o sistema for sensível à ordem, pode dar resultado inconsistente. Difícil reproduzir problema.  ·  (B) 2. Forçar ordem sequencial: aguardar primeira receita completar antes de processar segunda → Mais lento, mas determinístico. Garante que apartado sai sempre na mesma ordem.  ·  (C) 3. Marcar receitas como 'do mesmo pedido' e processar como lote único → Sistema junta as 10 unidades em um único comando de apartado. Mais rápido e claro.
- **Recomendação:** Opção 3: processar receitas do mesmo pedido como um lote. Assim não importa se chegam em paralelo — 10 unidades são apartadas de uma vez. Evita duas ações no mesmo instante e é mais eficiente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/reconciliador-oc.ts:83-109

### D257 — Quando você vende um kit que tem componentes espalhados em várias prateleiras, o que o sistema deveria fazer?
- [ ] **vou fazer** · fluxo: Custo médio do produto
- **Imagina assim:** Você cria um kit virtual: 1 pneu + 1 capa + 1 aro. O pneu está na prateleira A, a capa está na prateleira B, o aro está na prateleira C. Um cliente compra o kit.
- **Hoje:** O sistema tenta pegar o pneu de uma prateleira (a do kit), a capa de outra prateleira (a do kit), o aro de outra (a do kit). Não encontra componente onde esperava — e a venda falha. O cliente não recebe nada.
- **Por que importa:** Você montou um kit, pessoas compraram, mas o sistema não consegue separar porque ele é teimoso — exige cada peça na mesma prateleira do kit. Pedidos caem.
- **Opções:** (A) Sistema traz cada componente de onde realmente está (não exige estar no mesmo lugar) → Funciona — kit sai. Mas você precisa ter pegado cada componente do lugar certo.  ·  (B) Avisar ao operador: 'Esse kit tem componentes espalhados, separa tudo numa prateleira antes de vender' → Seguro — operador escolhe. Mas é trabalho manual de transferência.  ·  (C) Sistema automaticamente reúne os componentes numa prateleira e depois monta → Transparente ao operador. Mas sistema faz trabalho extra.
- **Recomendação:** Opção 1 + avisar claro. Se componente está em prateleira diferente, sistema pega de lá, não falha. Se quiser controlar, é sua escolha na hora de vender.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:282-352

### D258 — Reservas expirando em 6 horas — painel conta 7, mas 2 delas têm pedidos cancelados. Como contar?
- [ ] **vou fazer** · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** 5 unidades de um produto estão apartadas pra pedidos que estão sendo processados. 2 unidades estão apartadas pra pedidos que foram cancelados. O painel mostra 'Expirando em 6 horas: 7'. Mas essas 2 unidades de pedidos cancelados vão ser devolvidas ao estoque de qualquer forma (o sistema faz limpeza automática). Contar elas como 'risco' é enganoso.
- **Hoje:** Painel simplesmente conta todas as apartações expirando, sem filtrar se o pedido ainda é válido ou não.
- **Por que importa:** Dono vê 'Risco de desabastecimento: 7 unidades' quando na verdade só 5 são risco real. As outras 2 vão voltar sozinhas. Cria falso alarme. Dono pode tomar ação desnecessária (comprar mais, realocar, etc).
- **Opções:** (A) Painel mostrar duas métricas separadas: 'Apartadas de pedidos ativos expirando: 5' + 'Apartadas órfãs expirando: 2 (serão devolvidas automaticamente)' → Dono vê a verdade. Sabe que o risco real é 5, não 7. Toma decisão certa.  ·  (B) Deixar como está mas adicionar uma observação: '7, incluindo X órfãs' → Menos intrusivo, mas dono precisa ler a observação. Pode passar despercebido.  ·  (C) Filtrar automaticamente: não contar órfãs na métrica 'Expirando', deletar as órfãs mais rápido (em 1 hora em vez de 6). → Número mostrado (5) é sempre correto. Mais limpeza automática, menos debt.
- **Recomendação:** Opção 1: duas métricas. Dono entende a situação real e toma decisão confiante. Custos zero, clareza máxima.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/dashboard-geral.ts:43-49

### D259 — Como o sistema deveria evitar que dois cliques simultâneos criem estoque apartado duplicado?
- [ ] **vou fazer** · fluxo: Processamento automático de pedidos aprovados
- **Imagina assim:** Um gerente clica em 'Aprovar pedido' enquanto o sistema ainda está processando o primeiro clique. Os dois chegam ao mesmo tempo.
- **Hoje:** O sistema permite que os dois pedidos passem na validação quase ao mesmo tempo. Ambos criam estoque apartado — se o pedido precisa de 10 unidades, o sistema pode apartar 20 (10 em cada processamento).
- **Por que importa:** Estoque fica errado. Dois clientes acham que recebem, mas só um recebe. Ou nem um consegue porque estoque acabou (vendido pra cliente que não era pra ser).
- **Opções:** (A) Trancar o pedido: fazer uma alteração no banco primeiro, só soltar se conseguir mudar a etapa → Segundo clique já encontra o pedido em progresso, desiste e avisa pro usuário. Estoque apartado apenas uma vez.  ·  (B) Deixar como está (janela de 500ms de risco) → Continua havendo chance (pequena) de duplicação. Risco permanente.
- **Recomendação:** Trancar o pedido. Elimina o risco completamente e o usuário sabe que aprovou.
- **➡️ MINHA ESCOLHA:** 
- **Código:** aprovar/route.ts:108-338

### D260 — O que fazer quando estorno de estoque apartado falha no meio?
- [ ] **vou fazer** · fluxo: Processamento automático de pedidos aprovados
- **Imagina assim:** Um pedido é aprovado e cria 3 estoques apartados. Depois precisa devolver tudo. O sistema consegue devolver 2, mas o terceiro falha (outro usuário já mexeu naquele estoque).
- **Hoje:** O sistema registra qual estoque apartado ficou preso e envia um aviso com a lista pro operador. O estoque preso fica ocupando a prateleira até 30 dias (depois expira sozinho).
- **Por que importa:** Essa prateleira não pode ser vendida. Se muitos estoques ficam presos, não tem mais lugar pra vender.
- **Opções:** (A) Deixar como está: operador limpa manualmente após receber o aviso → Funciona se operador age rápido. Risco de atraso se ninguém vê o aviso.  ·  (B) Limpeza automática após 30 dias → Estoque volta automaticamente pro prateleira (já faz isso). Operador só mexe se quiser antecipar.  ·  (C) Rejeitar o pedido inteiro se um estorno falha → Mais seguro, mas bloqueia o operador de resolver.
- **Recomendação:** Manter como está. Operador recebe aviso, limpa manualmente ou espera 30 dias. Sistema está protegido.
- **➡️ MINHA ESCOLHA:** 
- **Código:** aprovar/route.ts:591-619

### D261 — E se o estoque mudou entre lançar a compra e acertar?
- [ ] **vou fazer** · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Operador lança retroativo de 10 peças (acha que tinha chegado). Depois, alguém faz picking e tira 9 peças. Agora o operador volta e clica 'Acertar' aquele lançamento de 10.
- **Hoje:** Sistema tenta tirar 10 peças de novo. Mas saldo só tem 6 (5 + 10 - 9), então falha.
- **Por que importa:** Em negócio real, estoque mexe enquanto você está 'acertando contas'. Se uma nota saiu de madrugada (você lançou retroativo), depois alguém vendeu, agora o acerto fica confuso.
- **Opções:** (A) Permitir 'acerto parcial': operador vê que tinha 10 mas só sobrou 6, digita 6 e acerta só isso. → Mais trabalho pro operador, mas estoque fica exato.  ·  (B) Marcar nota como 'resolvida' sem tirar estoque fisicamente — só registra que você sabia que tinha chegado. → Não causa confusão com saldo, mas fica um registro 'pendente' eternamente.  ·  (C) Assumir que acerto é sempre do total (10): se falhar por saldo, avisar que alguém mexeu e deixar pra operador decidir. → Operador lê a mensagem, vê que venderam 9, decide se quer acertar 1 ou 10.
- **Recomendação:** Opção 1 — mais realista pra galpão que mexe enquanto você está atualizando.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:613-628


## Tema: Recebimento e guarda de mercadoria (13)

### D262 — Pedido foi recebido em um galpão e depois transferido parcialmente para outro. Se cancelar, dois galpões ficam com saldo errado?
- [ ] **vou fazer** · fluxo: Cancelamento e devolução de pedido ao estoque
- **Imagina assim:** Compra chegou: 10 unidades no galpão de Curitiba em prateleira A-01-10. Depois, operador transferiu 3 unidades para o galpão de São Paulo (em prateleira temp). Agora quer cancelar a compra inteira.
- **Hoje:** Sistema cancela só a entrada original (em Curitiba). A transferência das 3 unidades pra São Paulo fica órfã: São Paulo fica com 3 unidades que não tem origem, Curitiba fica com falta de 3. Os dois galpões ficam desbalanceados — saldo não bate quando você soma.
- **Por que importa:** Você pensa: 'cancelei a compra, saldo volta'. Mas saldo não volta em São Paulo. Dias depois descobre que tem 3 unidades que ninguém sabe de onde vieram. Inventário fica ruim.
- **Opções:** (A) Bloquear cancelamento se há transferência parcial em andamento → Força operador a desfazer a transferência antes. Mais seguro, mas mais passos.  ·  (B) Ao cancelar, desfazer também as transferências associadas (volta tudo pra origem) → Automático. Mas complexo se transferência foi parcial.
- **Recomendação:** Quando cancela uma compra que foi transferida parcialmente, voltar as 3 unidades de São Paulo pra Curitiba automaticamente, depois cancelar tudo junto. Garante que dois galpões ficam equilibrados.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/pedidos/[pedidoId]/cancelar/route.ts:85-128

### D263 — Se a rede cai no meio do recebimento de uma compra, o que acontece?
- [ ] **vou fazer** · fluxo: Recebimento de Compra de Fornecedor
- **Imagina assim:** Operador confirma os 10 itens de uma compra, mas a internet cai quando está gravando o 4º item. Já gravou 3 itens com sucesso.
- **Hoje:** O sistema grava o que consegue (os 3 que entraram) e mostra um aviso de sucesso. A compra fica marcada como recebida em parte, e o operador pode chamar receber de novo para os outros 7 itens.
- **Por que importa:** Se a rede cai, você precisa saber se pode tentar de novo sem duplicar o estoque, ou se o sistema vai travar esperando pelas transações completas.
- **Opções:** (A) Deixar como está (sucesso parcial): o operador pode sempre chamar receber de novo → Mais rápido, operador não espera, compra fica marcada parcial até completar  ·  (B) Travar a compra inteira: se um item falhar, desfaz todos e nenhum item entra → Mais seguro, mas operador perde tempo esperando a rede voltar pra tentar de novo
- **Recomendação:** Fique com sucesso parcial (deixar como está). Melhor experiência: se a rede cai, não perde o que entrou. Mas coloque um botão grande 'Receber os 7 itens restantes' pra facilitar a vida do operador.
- **➡️ MINHA ESCOLHA:** 
- **Código:** receber-oc.ts:82-304

### D264 — Se uma transferência fica parada muito tempo sem receber, o que acontece com ela?
- [ ] **vou fazer** · fluxo: Recebimento de Estoque Transferido de Outro Galpão
- **Imagina assim:** Uma transferência foi criada para levar 50 mouses pro galpão São Paulo, mas por algum motivo ninguém recebeu ela. Passam 7 dias.
- **Hoje:** O sistema tem um prazo de 7 dias que está nos registros, mas não faz nada automaticamente quando passa. A transferência continua lá, aparentemente esperando recebimento, e pode confundir o operador depois (acha que é nova, tenta receber novamente).
- **Por que importa:** Transferências velhas entopem o sistema e causam confusão. Se o operador tenta receber uma que já deveria ter expirado, pode contar quantidade errada no estoque. Além disso, o galpão origem acha que mandou mas nunca saiu de lá.
- **Opções:** (A) Deixar como está: transferência fica aberta para sempre, depende de alguém deletar manualmente se expirou → Mais simples de codificar, mas gera bagunça no longo prazo. Acumula histórico inútil.  ·  (B) Cancelar automaticamente após 7 dias: ao passar do prazo, o sistema marca como expirada e bloqueia recebimento → Mais limpo. Transferências antigas ficam fora do caminho. Operador vê que expirou e sabe que precisa fazer uma nova.  ·  (C) Avisar antes de expirar: 1 dia antes de vencer os 7 dias, gera um alerta no sistema pra alguém receber → Dá uma chance de salvar se foi só atraso. Mas alguém tem que ficar olhando alerts.
- **Recomendação:** Cancelar automaticamente após 7 dias. Deixa o sistema limpo e força a pessoa a criar uma transferência nova se realmente precisa. Mais seguro que deixar velhas por aí.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Recebimento de Estoque Transferido de Outro Galpão")

### D265 — Quando recebemos uma peça que já tem um pedido na fila esperando, podemos mandar direto pro final (packing/embalagem), pulando a prateleira?
- [ ] **vou fazer** · fluxo: Recebimento avulso (achado, devolução, ajuste manual)
- **Imagina assim:** SKU-Y chegou do fornecedor. Ao mesmo tempo, há 1 pedido de cliente na fila esperando por SKU-Y. Poderia colocar a mercadoria direto na embalagem em vez de guardar na prateleira.
- **Hoje:** O sistema conhece a lógica de 'cross-dock' (entregar direto pro pedido sem guardar), mas você não consegue marcar a flag no recebimento e ver o sistema sugerir a embalagem como destino. Provavelmente ainda está sendo codificado.
- **Por que importa:** Se a mercadoria já sai do recebimento direto pro pedido, economiza tempo e manuseio. Menos chance de erro, despacha mais rápido.
- **Opções:** (A) Ativar o botão 'ENTREGA DIRETA' no recebimento. Operador marca, e o sistema automaticamente manda a peça pro final (embalagem), com badge verde de prioridade. → Mais rápido, menos movimento desnecessário. Pedidos saem mais cedo.  ·  (B) Continuar guardando tudo na prateleira. Cross-dock fica só no código, não na prática. → Mais movimentação, lentidão, risco de confusão.
- **Recomendação:** Ative o cross-dock. Operador ganha velocidade, cliente ganha rapidez na entrega.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/guarda.ts:134-139, 61 (cross_dock fields); src/supabase/migrations/20260514_wms_guarda_pendencias.sql (não tem cross_dock colunas, só status)

### D266 — Quando o operador clica para confirmar a guarda e recebe mensagem de erro na tela, como a gente garante que a mercadoria foi realmente guardada?
- [ ] **vou fazer** · fluxo: Rota de Guarda Otimizada
- **Imagina assim:** Um operador está guardando itens no galpão. Ele bipa a mercadoria (3 unidades), o sistema processa, mas a conexão de internet cai antes de mostrar sucesso na tela.
- **Hoje:** O sistema grava a informação no banco de dados (a mercadoria é contabilizada como guardada), mas a tela mostra erro. O operador vê a mensagem de problema e não sabe se deu certo ou não.
- **Por que importa:** Se o operador clicar novamente para 'confirmar', o sistema vai rejeitar porque a quantidade já foi contabilizada. Mas se ele tentar guardar de novo por não ter visto o sucesso, fica confusão. Precisa de clareza total sobre o que foi guardado e o que não foi.
- **Opções:** (A) A tela atualize automaticamente após erro — se a gente vê que os itens já foram guardados, mostra mensagem de sucesso silenciosa → Operador fica tranquilo sabendo o resultado real de cada tentativa  ·  (B) O sistema numera cada tentativa de confirmação e rejeita confirmações duplicadas → Mesmo que o operador clique várias vezes, só entra uma vez no sistema
- **Recomendação:** A opção 1 é mais intuitiva no galpão — o operador precisa de feedback claro, não de lógica complexa. Quando erra a conexão, refaz a tela e mostra se deu certo ou não.
- **➡️ MINHA ESCOLHA:** 
- **Código:** guarda.ts:345-402

### D267 — Se um operador começa a guardar, depois o tablet cai, como a gente cuida dessa 'guarda parada no meio do caminho'?
- [ ] **vou fazer** · fluxo: Rota de Guarda Otimizada
- **Imagina assim:** Operador José começa a guardar um lote de 10 unidades no galpão (o sistema marca que José está trabalhando nisso). De repente o tablet descarrega. Ele volta 20 minutos depois com um tablet novo ou o mesmo carregado.
- **Hoje:** Quando José loga de novo, a tela vê que aquele lote ainda está 'em guarda' com seu nome. A tela relê automaticamente e deixa ele continuar de onde parou — como se nada tivesse acontecido.
- **Por que importa:** Sem essa proteção, ou o lote ficaria 'preso' esperando José voltar, ou outro operador (Maria) poderia começar a guardar o mesmo lote e criar bagunça (dois guardando a mesma coisa). É sobre controlar quem mexe em quê.
- **Opções:** (A) Deixar como está — o lote fica 'reservado' para José até ele terminar ou abandonar voluntariamente → Protege de dois guardarem juntos, mas se José não voltar, o lote fica parado indefinidamente  ·  (B) Se o tablet cai e José não volta em 1-2 horas, liberar o lote automaticamente para outro operador pegar → Evita lotes travados, mas se José voltar, pode ficar confuso vendo outro operador no seu lote
- **Recomendação:** Depende do tamanho do seu galpão. Se é pequeno (poucos operadores), deixar travado (opção 1) é simples — José sempre volta logo. Se é grande, liberar após 2 horas (opção 2) garante que a operação não para.
- **➡️ MINHA ESCOLHA:** 
- **Código:** guarda.ts:356-357; page.tsx:367-373

### D268 — Quando o operador recebe MAIS do que foi pedido, o que fazer com o excesso?
- [ ] **vou fazer** · fluxo: Recebimento de compras de fornecedor com conferência
- **Imagina assim:** Pedido P1 de compra: 10 unidades. Fornecedor manda 15 (ou o operador conferiu errado e contou 15). Operador digita 15 e submete
- **Hoje:** O sistema aceita só os 10 que foram pedidos. Os 5 extras não ficam registrados em lugar nenhum. Se o operador quer contar aqueles 5 mesmo assim, precisa fazer OUTRO recebimento do mesmo pedido, ou ajustar manualmente depois no inventário.
- **Por que importa:** Se você recebeu 15 e o sistema marca 10, na próxima venda o saldo fica errado e você vende o que não tem. Ou perde estoque por não saber que chegou.
- **Opções:** (A) Rejeitar: se vier mais do que pediu, o operador devolve e tira da caixa → Saldo sempre bate. Mas precisa de processo manual de devolução e papelada.  ·  (B) Aceitar e guardar num 'fila de ajustes': registra 10, e aqueles 5 ficam num aviso pro gerente confirmar depois → Não perde estoque, mas fica em suspenso até alguém conferir.  ·  (C) Aceitar tudo de uma vez: registra 15 como se fosse normal, com uma nota de que têm 5 a mais → Saldo fica certo. Fácil pro operador. Precisa de um ajuste contábil depois (ganho vs erro de compra).
- **Recomendação:** Deixa receber 15, mas marca claramente que é 5 a mais. O sistema registra as 15 unidades normalmente. Gera um aviso pra o gerente com a nota 'Recebimento: 15 unidades (5 a mais que o pedido de 10)'. Assim o saldo fica certo na hora e ninguém esquece de revisar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:79-83, compras-utils.ts:85-89

### D269 — Depois que a mercadoria chegou e foi registrada, como devolver parte dela?
- [ ] **vou fazer** · fluxo: Recebimento de compras de fornecedor com conferência
- **Imagina assim:** Semana passada recebemos 10 unidades de um item. Hoje o operador conferiu e achou 3 unidades com defeito. Quer devolver só aquelas 3.
- **Hoje:** Não tem um botão de 'devolvo parte'. O sistema marcou as 10 como recebidas de forma permanente. Se o operador quer tirar 3 do saldo, ele tem que fazer um 'ajuste de perda' manual (tipo de movimento especial), que gera um desconto de 3 no inventário. Ou faz uma 'saída' que registra no livro de movimentação.
- **Por que importa:** Se você tem 3 unidades ruins no galpão e ninguém tira do saldo, na próxima venda o sistema acha que tem mais do que realmente tem. Ou você tira do saldo mas fica registrado como 'perda' em vez de 'devolução', e a contabilidade fica confusa.
- **Opções:** (A) Fazer um ajuste de perda: operador marca 3 como perdidas e pronto → Saldo cai de 10 pra 7. Mas fica registrado como 'perda', não como 'devolução ao fornecedor'.  ·  (B) Fazer uma devolução ao fornecedor: operador marca 3 pra devolver, o sistema gera um número de saída, depois o fornecedor confirma → Tudo fica rastreado. Fornecedor e seu lado sabem que tem 3 vindo de volta. Contabilidade entende que é devolução, não perda.  ·  (C) Criar um pedido reverso de compra: 3 unidades saem de volta ao fornecedor com nota de crédito → Mais complexo, mas a contabilidade fecha certinho. Fornecedor recebe crédito.
- **Recomendação:** Cria um botão 'Devolver ao fornecedor' direto do recebimento. Operador marca 3 unidades pra devolução, o sistema gera um número de saída, tira do saldo e avisa o fornecedor. Fica claro que é devolução (não perda) e rastreável em ambos os lados.
- **➡️ MINHA ESCOLHA:** 
- **Código:** n/a

### D270 — Se um dos itens da transferência falhar na hora de guardar (ex: prateleira cheio, erro no banco), o que fazer com os outros itens que já foram guardados?
- [ ] **vou fazer** · fluxo: Recebimento de transferência entre galpões
- **Imagina assim:** Transferência com 5 itens. Sistema guarda com sucesso SKU A (50 unidades), SKU B (30), SKU C (20). Na hora de guardar SKU D: sistema tenta, colisão com outra operação, falha. SKU E não foi tentado ainda.
- **Hoje:** Sistema para, loga erro, e deixa a transferência com 3 itens guardados e 2 pendentes. Transferência fica em etapa 'em trânsito' (não completa). Se operador tenta de novo, SKU A/B/C tentam guardar outra vez — pode gerar duplicação ou erro de 'já existe'.
- **Por que importa:** Você precisa saber: aquele SKU D entrou no galpão ou não? Se deixar 'pendente pra depois', pode: 1) esquecer e pensar que não chegou; 2) tentar guardar duas vezes e contar duas vezes; 3) deixar meia-entrada que confunde o saldo.
- **Opções:** (A) Aceitar estado parcial ('3 de 5 guardados'). Operador vê qual falhou, corrige, tenta de novo. Sistema é inteligente pra não duplicar. → Flexível, mas exige que operador resolva manual. Se esquecer, fica órfão. Melhor se houver bom aviso visual.  ·  (B) Tudo ou nada: se SKU D falha, desfazer os 3 que já foram guardados (voltar A/B/C pra 'pendente'), e operador começa tudo de novo. → Mais seguro (zero risco de parcial), mas mais frustrante (tem que refazer tudo pra um item que falhou). Útil se a taxa de falha é muito baixa.
- **Recomendação:** Hoje está funcionando como 'aceitar parcial + sem repetição'. Isso é ok, mas você precisa de um bom painel pra ver quais itens falharam e quais não — senão operador esquece e deixa órfão. Se implementar isso, garanta que a interface mostra CLARO 'item D falhou, tente de novo'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/transferencias.ts:325-403

### D271 — Se o servidor cair no meio do recebimento (luz cai, servidor falha), a transferência fica travada para sempre?
- [ ] **vou fazer** · fluxo: Recebimento de transferência entre galpões
- **Imagina assim:** Operador A clica 'Confirmar'. Sistema registra 'A está recebendo' e começa guardar. No meio, o servidor cai (OOM, timeout, reinicia). Operador A vê erro na tela, vai beber água.
- **Hoje:** Servidor volta online. Transferência tem um campo 'recebimento em andamento por A' setado. Operador B tenta receber a mesma transferência. Sistema vê que alguém (A) começou e nunca terminou, bloqueia B com erro 'recebimento já em andamento'. Transferência fica eternamente travada até que um admin do banco de dados limpe a mão.
- **Por que importa:** Se servidor cai uma vez a cada 100 transferências, você terá 'transferências presas' que ninguém consegue desbloquear sem admin. Isso é lento (você chama dev) e frustrante.
- **Opções:** (A) Deixar como está (status quo). Cade vez que cair, você ou outro admin vai ao banco e limpa a mão. Documentação deixa claro o problema. → Nenhuma mudança de código (rápido). Mas tem custo operacional (cada queda = 1 intervalo admin).  ·  (B) Adicionar limpeza automática: sistema detecta 'recebimento em andamento há mais de 1 hora, mas a etapa não mudou' → libera automático (assume que morreu). Bloqueia transferências super recentes (menos de 5 min) pra não liberar durante queda rápida. → Self-healing. Transferência destranca automaticamente após 1h de inatividade. Operador B consegue tentar de novo. Reduz dependência de admin.
- **Recomendação:** Implementar limpeza automática de bloqueios antigos (1 hora +). Já está documentado no código que é um trade-off — agora é hora de resolver. Evita travamentos crônicos.
- **➡️ MINHA ESCOLHA:** 
- **Código:** supabase/migrations/20260527_p3_transferencia_recebimento_em_andamento.sql:24-27

### D272 — Quando chega estoque novo do fornecedor, o sistema leva quanto tempo pra mostrar que chegou? E se o operador não esperar, consegue confiar no que vê na tela?
- [ ] **vou fazer** · fluxo: Painel de cobertura de estoque
- **Imagina assim:** Chegam 100 unidades no almoxarifado às 14:59. O operador vê na tela quanto tempo depois disso?
- **Hoje:** O sistema atualiza automaticamente a cada 1 minuto. Se o operador conferir 30 segundos depois que registrou, a tela ainda mostra o número de antes — pode levar até 1 minuto pra ficar correto.
- **Por que importa:** Operador pode tomar decisão com informação errada (acha que não tem estoque quando na verdade tem, ou vice-versa). Causa confusão e risco de perder venda ou fazer guarda duplicada.
- **Opções:** (A) Deixar como está: atualização a cada 1 minuto e operador recarrega a página manualmente se precisa da informação no exato segundo. → Simples. Operador sabe que deve dar F5 na tela se precisa de número super quente. Toma 1 minuto no máximo.  ·  (B) Colocar 'sempre atualizar em tempo real' (cada movimento puxa a tela na mesma hora). → Mais preciso, mas mais lento (se muita mercadoria chega, tela fica piscando). Custa mais servidor.
- **Recomendação:** Deixar como está. Operador que precisa saber na hora faz F5 ou usa um botão de 'atualizar agora'. Automático a cada 1 minuto é suficiente pra 99% dos casos.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Painel de cobertura de estoque")

### D273 — O operador clica duas vezes rápido (menos de meio segundo) ao confirmar que recebeu uma SKU. O sistema conta duas receitas ou uma?
- [ ] **vou fazer** · fluxo: Quando estoque chega, ligar de novo os pedidos presos esperando compra
- **Imagina assim:** Operador confirma recebimento de 5 unidades da SKU 'Parafuso M10'. Clica no botão duas vezes rápido (0.3s entre cliques) antes da resposta do servidor chegar na tela.
- **Hoje:** Sistema pode criar dois registros de recebimento (duas receitas de 5 unidades cada = 10 contadas). O banco de dados tenta bloquear a duplicata, mas não garante — tudo depende se o controle está bem feito.
- **Por que importa:** Se contar duas vezes, o saldo fica inflado. Físico tem 5, sistema pensa que tem 10. Pedidos reservam dos números errados. Inventory fica desalinhado.
- **Opções:** (A) 1. Deixar como está (risco de duplicata por duplo clique) → De tempos em tempos, alguém clica rápido e saldo fica errado. Descoberta por acaso ao inventariar.  ·  (B) 2. Bloquear botão por 2s após clique (fica cinzento até a resposta voltar) → Impede clique duplo visualmente. Usuário vê o botão desativado e sabe que já foi.  ·  (C) 3. Rejeitar segunda receita se vier do mesmo operador/SKU em menos de 1s → Servidor detecta e nega. Operador recebe mensagem 'já foi recebido, tente novamente'.  ·  (D) 4. Gerar chave única — cada clique gera uma marca especial, segundo clique com mesma marca é ignorado → Tecnicamente robusto, mas invisível ao operador. Exige implementação cuidadosa.
- **Recomendação:** Opção 2: bloquear visualmente o botão por 2 segundos. É simples, o operador vê acontecendo e confia que já foi. Reduz 90% dos erros de duplo clique.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/compras/receber/route.ts:136-145

### D274 — Quando chegou mercadoria e o sistema tenta avisar que há estoque — e isso falha silenciosamente — o operador nunca fica sabendo?
- [ ] **vou fazer** · fluxo: Histórico de Movimentações de Estoque
- **Imagina assim:** Você recebe 50 unidades de um produto. O sistema tenta automaticamente atualizar um pedido que estava parado esperando por estoque. Se essa tarefa automática falhar, ela simplesmente desaparece do registro — operador não recebe aviso.
- **Hoje:** Sim. Quando você insere a entrada de mercadoria, o sistema dispara uma tarefa em segundo plano (sem esperar resposta). A tarefa tenta marcar no pedido que 'o estoque chegou'. Se der erro, só gera um log técnico que ninguém vê. O operador continua vendo o pedido parado e não sabe que a tarefa falhou.
- **Por que importa:** O operador pode achar que o pedido ainda está esperando estoque, quando na verdade a mercadoria já chegou. Isso causa atraso porque ele não retoma o trabalho no pedido. Além disso, se a tarefa de reconhecimento também falhar depois, o pedido fica completamente invisível (ninguém consegue processar).
- **Opções:** (A) Fazer a tarefa de forma síncrona (bloqueia o recebimento até terminar) → O recebimento fica mais lento, mas você garante que o aviso foi marcado. Se falhar, o recebimento não completa.  ·  (B) Deixar async (rápido) mas com tentativas automáticas (DLQ — fila de erro) → Recebimento rápido, e se falhar a primeira vez, o sistema tenta novamente sozinho.  ·  (C) Manter async, mas avisar o operador que o status pode estar pendente (pede para ele atualizar a tela) → Recebimento rápido, operador sabe que pode ter um pequeno atraso, atualiza a tela em 5 segundos.
- **Recomendação:** Escolha a opção 2. Mantenha o recebimento rápido, mas implemente tentativas automáticas. Se falhar 3 vezes, gere um alerta para o suporte revisar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:240-262


## Tema: Permissões e quem pode fazer o que (12)

### D275 — Quando alguém confirma a guarda de mercadoria, o sistema deve registrar quem guardou?
- [ ] **vou fazer** · fluxo: Guardagem de mercadoria recebida
- **Imagina assim:** João confirma que guardou 50 unidades na prateleira. A guarda é registrada com a data e hora, mas o nome de João fica em branco no sistema.
- **Hoje:** O sistema registra que a guarda aconteceu, quando foi, em qual prateleira, mas deixa vazio o campo 'quem guardou'.
- **Por que importa:** Se algo der errado depois (mercadoria no lugar errado, contagem errada), você não sabe quem guardou. Não consegue rastrear o erro.
- **Opções:** (A) Preencher automaticamente: sistema pega do login de quem está usando → Rastreabilidade 100%. Sempre saberá quem guardou cada item.  ·  (B) Deixar vazio (como está agora) → Nenhum rastreamento. Qualquer erro fica anônimo.  ·  (C) Pedir pra digitar (obrigatório): precisa confirmar o nome manualmente → Mais rastreável, mas mais lento. Alguém pode digitar nome errado.
- **Recomendação:** Automático (opção 1). Preencer quem guardou a partir do usuário logado. Assim tem rastreabilidade sem freiar o trabalho.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Guardagem de mercadoria recebida")

### D276 — Como proteger o operador que não tem galpão atribuído?
- [ ] **vou fazer** · fluxo: Iniciar a separação de pedidos
- **Imagina assim:** Novo funcionário contratado, recebe um código de acesso ao sistema de estoque. Login funciona. Mas ninguém setou qual galpão ele trabalha (ou removeram essa permissão depois). Operador tenta iniciar uma onda de picking.
- **Hoje:** O sistema deixa ele fazer tudo. Marca os pedidos como 'em separação', registra o nome dele como quem iniciou. Mas no celular dele (que filtra por galpão), os pedidos não aparecem. Ele vê lista vazia, mas os pedidos já estão lá no registro marcados com o nome dele. Depois, quando alguém do galpão certo reconecta, os pedidos aparecem.
- **Por que importa:** Confusão: alguém iniciou a onda mas os pedidos desapareceram da tela de quem iniciou. Depois aparecem pra outra pessoa. Risco de pedido sendo iniciado por um, mas separado por outro (falta rastreamento claro de responsabilidade).
- **Opções:** (A) Validar no celular: bloquear o botão 'iniciar picking' se operador não tem galpão setado → Erro aparece no celular antes de tentar. Mais simples, mas depende do app estar atualizado.  ·  (B) Validar no servidor: rejeitar a requisição se o galpão do operador não bate com o galpão dos pedidos → Seguro, funciona em qualquer versão do app. Operador não consegue nem iniciar se não for dele.
- **Recomendação:** Validar no servidor. Sempre mais seguro. Ninguém inicia picking de um galpão que não é dele.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:19-22

### D277 — Qualquer operador pode cancelar um pedido?
- [ ] **vou fazer** · fluxo: Cancelamento de Separação
- **Imagina assim:** Você tem operadores juniores e supervisores. Um junior consegue cancelar pedido em separação só porque tem conta no sistema.
- **Hoje:** Sistema deixa qualquer pessoa logada cancelar. Sem restrição de cargo ou role.
- **Por que importa:** Risco de cancelamentos errados. Se alguém cancela propositalmente o pedido errado, gera retrabalho.
- **Opções:** (A) Deixar aberto — qualquer operador cancela → Flexível; risco: pessoa errada, ato intencional  ·  (B) Restringir para supervisores ou gerentes → Mais controle; menos flexibilidade, mais segurança
- **Recomendação:** Escolha a Opção 2. Apenas supervisores deveriam cancelar.
- **➡️ MINHA ESCOLHA:** 
- **Código:** cancelar/route.ts:27-30

### D278 — Quando alguém com permissão especial (um gerente) cria um pedido 'em nome de' outro vendedor (João), como registrar quem realmente criou?
- [ ] **vou fazer** · fluxo: Criar uma venda na mão
- **Imagina assim:** Um gerente precisa criar um pedido manualmente para um vendedor João (talvez o vendedor estava offline, ou o gerente assumiu uma venda via telefone). O sistema precisa saber: quem REALMENTE criou este pedido (gerente), e em nome de quem foi criado (João).
- **Hoje:** O sistema já tem a lógica pronta: valida se o gerente tem permissão 'criar em nome de alguém'. Se tiver, cria o pedido em nome de João, e guarda internamente quem foi o gerente que criou. Mas a tela, o botão/campo não aparece ainda — a permissão ainda não existe oficialmente (está marcada como futura).
- **Por que importa:** Para auditoria e responsabilidade. Você precisa saber depois: 'Este pedido foi criado pelo gerente Silva em nome do vendedor João, dia tal, hora tal.' Se a mercadoria desaparecer ou houver reclamação, você rastreia. Também controla quem pode fingir ser vendedor (só gerentes, não qualquer um).
- **Opções:** (A) Ativar a permissão e deixar gerentes criarem em nome de vendedores → Gerentes ganham flexibilidade. Auditoria fica completa (quem criou + em nome de quem). Operação manual fica mais ágil.  ·  (B) Manter bloqueado (cada um cria só suas próprias vendas) → Mais segurança (menos gente mexendo em venda alheia), mas menos flexibilidade operacional. Gerente não consegue criar pedido 'em nome de' quando precisa.
- **Recomendação:** Ativar a permissão. O sistema por tras já está pronto, a auditoria está pronta. É só liberar a tela e treinar os gerentes (eles precisam entender que gera registro).
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:131-168

### D279 — Quando um vendedor sai de licença, outro pode 'pegar' o pedido dele?
- [ ] **vou fazer** · fluxo: Reatribuição do responsável de uma venda
- **Imagina assim:** Pedido estava com João. João saiu de licença. Maria (que é admin/operadora) reatribui pra Pedro.
- **Hoje:** Sistema permite. O pedido muda de João pra Pedro. O histórico anota que foi Pedro quem mudou. O pedido continua o mesmo, estoque o mesmo — é só um rótulo administrativo.
- **Por que importa:** Depois que reatribui, Pedro vai separar/embalar o pedido. Se Pedro não tem permissão pra fazer essas coisas, o pedido pode ficar travado.
- **Opções:** (A) Deixar reatribuir, sem avisar nada → Sistema muda e pronto. Se Pedro não tem permissão, ele descobre quando tentar separar.  ·  (B) Deixar reatribuir, mas avisar se o novo vendedor não pode separar/embalar → Maria reatribui → a tela mostra aviso: 'Pedro não tem permissão pra separação, revise'. Maria pode desistir ou continuar mesmo assim.
- **Recomendação:** Use a opção 2. Aviso sem bloquear — assim Maria sabe que Pedro talvez vá ter problema, mas não trava a reatribuição.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/vendas/[id]/vendedor/route.ts:75-82

### D280 — Um vendedor pode 'reivindicar' um pedido que não tem dono?
- [ ] **vou fazer** · fluxo: Reatribuição do responsável de uma venda
- **Imagina assim:** Pedido entrou como venda manual, ninguém atribuiu a ninguém ainda. João (vendedor) abre o detalhe → vê vendedor vazio/em branco → clica 'Editar' → seleciona 'João Silva' → clica 'Salvar'.
- **Hoje:** Sistema rejeita com 'Você não tem permissão'. João vê erro. Só admin/operador consegue atribuir.
- **Por que importa:** Pedido fica sem dono até admin chegar pra atribuir. Demora burocrática desnecessária. Se João já é vendedor, faz sentido ele reivindicar o dele.
- **Opções:** (A) Continuar como está — só admin/operador podem atribuir → Pedido espera admin. Mais controle, mais burocracia.  ·  (B) Permitir auto-reivindicação se o pedido não tem dono ainda → João vê pedido sem dono → clica 'Reivindicar' → sistema atribui a ele. Mais rápido, menos burocracia.
- **Recomendação:** Depende de vocês — qual é a cultura da empresa? Se confiam que o vendedor vai reivindicar o certo, permite. Se acha que vai dar confusão, bloqueia.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/vendas/[id]/vendedor/route.ts:56-58

### D281 — Se um operador tiver permissão pra adicionar um código de fornecedor, e depois você remove a permissão dele, ele consegue deletar o código que tinha adicionado antes?
- [ ] **vou fazer** · fluxo: Equivalentes de Peças (Catálogo de Substituições)
- **Imagina assim:** Operador A adiciona código OEM-100. Depois você remove a permissão de 'editar produtos' do Operador A. A tenta deletar OEM-100.
- **Hoje:** O sistema checa: 'Operador A criou OEM-100?' Sim? Deixa deletar. Não checa se ele ainda tem permissão de editar. O motivo é: o código foi criado por ele, é propriedade dele, então ele pode desfazer.
- **Por que importa:** Você precisa decidir: permissão é tipo 'diploma' (se tirar, perde tudo) ou 'contrato' (o que você fez no passado fica seu)? Um operador que adicionou 100 códigos e perdeu permissão consegue limpar depois ou fica tudo preso?
- **Opções:** (A) Deixar deletar mesmo sem permissão — se criou, pode remover. → Operador que perdeu acesso consegue desfazer o trabalho antigo. Menos bagunça abandonada, mas pode parecer que a permissão não tá sendo respeitada.  ·  (B) Exigir permissão ativa — nem quem criou consegue deletar se não tiver permissão no momento. → Permissão é lei mesmo. Operador perde acesso, perde tudo — nem o que criou consegue tocar. Mais rigoroso, evita surprise de operador removendo coisa importante.
- **Recomendação:** Recomendo DEIXAR DELETAR. Um operador que criou um código deve conseguir corrigir ou remover o que criou, mesmo que tenha perdido permissão depois. É tipo: você criou um lembrete no seu notebook — se perder cargo, seu notebook é seu mesmo assim. Evita bagunça de código órfão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** oems/[codigo]/route.ts:37-45, specs:272

### D282 — Quando produto vira de uma empresa pra outra (pedido cruzado entre empresas), quem pode ajustar o estoque? A empresa que tá pedindo ou a empresa dona do saldo?
- [ ] **vou fazer** · fluxo: Corrigir quantidade de estoque no painel
- **Imagina assim:** Pedido de Empresa A. Produto foi entregue e tá no galpão de Empresa B (empresa dona do estoque local). Operador de Empresa A quer 'corrigir' o saldo.
- **Hoje:** Sistema encontra empresa ativa no galpão, usa conexão dela pro Tiny. Mas não fica claro se operador de Empresa A deveria ter permissão pra mexer em estoque de Empresa B.
- **Por que importa:** Multi-empresa: precisa saber quem é dono do estoque (quem pode mexer). Ajuste inline é operação de pré-aprovação (antes de pedido sair). Pós-aprovação, quem mexe no estoque?
- **Opções:** (A) Permitir qualquer empresa mexer em estoque de qualquer empresa (como hoje, talvez) → Flexível, mas sem controle de quem pode fazer o quê.  ·  (B) Bloquear ajuste inline pra multi-empresa. Use apenas ajuste de inventário que é 3D-aware → Obriga caminho formal. Controle melhor, auditoria clara.
- **Recomendação:** Opção 2: se usa multi-empresa, desabilita ajuste inline e força ajuste de inventário. Se é single-empresa, ajuste inline tá ok.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/tiny/stock/ajustar/route.ts:66-78, 108-113

### D283 — Quando admin muda o operador de loja (ex: de Curitiba para São Paulo), deve bloquear ou avisar?
- [ ] **vou fazer** · fluxo: Gestão de funcionários e acesso aos galpões
- **Imagina assim:** João estava atribuído à loja de Curitiba e começou a separar os primeiros pedidos (status=em separação). Admin edita João e tira Curitiba, marcando São Paulo.
- **Hoje:** Sistema permite. João perde visibilidade de Curitiba imediatamente. Os pedidos que ele estava separando em Curitiba ficam no sistema mas João não consegue mais vê-los — ninguém consegue terminar de separar.
- **Por que importa:** Operação fica pendurada. Se João estava no meio de separar 3 pedidos de Curitiba, aqueles 3 ficam congelados — nem João vê mais (trocou de loja) nem outro operador consegue continuar (eram de João). Pode atrasar entrega.
- **Opções:** (A) Bloquear: sistema recusa mudar a loja se tem separações em andamento → Admin vê mensagem 'João tem 3 separações em Curitiba, termine antes de mudar'  ·  (B) Avisar só, sem bloquear: mensagem amarela, mas deixa mudar → Admin fica avisado mas pode mudar assim mesmo (sob risco)  ·  (C) Deixar mudar e redirecionar separações abertas → Pedidos migram para novo supervisor ou ficam abertos; mais complexo
- **Recomendação:** Escolha a opção 1 (bloquear): é a mais segura. 'Termina os pedidos abertos em Curitiba, daí troca de loja.' Simples e evita deixar trabalho pendente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:196-203, lib/session.ts:80-95, aba-funcionarios.tsx:773-781

### D284 — Admin adicionou uma nova loja para um operador que está logado. Quando ele vê?
- [ ] **vou fazer** · fluxo: Gestão de funcionários e acesso aos galpões
- **Imagina assim:** João está logado e trabalhando na loja de São Paulo. Nesse momento, admin edita João e adiciona a loja de Curitiba ao seu perfil.
- **Hoje:** Sistema salva a mudança no banco. Mas João continua vendo só São Paulo no seu menu (porque a lista está em cache, ~5 minutos). Curitiba não aparece até ele fazer refresh manual ou esperar 5 minutos.
- **Por que importa:** João acha que não tem acesso a Curitiba ainda. Ou não sabe que foi adicionado. Sem feedback claro, cria dúvida e retrabalho.
- **Opções:** (A) Deixar como está (atraso de 5 minutos, sem aviso) → Funcionário não sabe que foi adicionado até notar sozinho  ·  (B) Invalidar a sessão de João imediatamente (força re-login) → Inconveniente: João tira a gente do que estava fazendo  ·  (C) Mostrar badge 'Novo acesso adicionado' (ex: 'Curitiba foi adicionado ao seu perfil') → João sabe que mudou, pode refresh se quiser  ·  (D) Documentar o atraso e deixar como está → Admin sabe que leva ~5min pra aparecer (expectativa ajustada)
- **Recomendação:** Escolha a opção 3 (badge de novo acesso): melhor UX. Avisa sem forçar re-login. Ou opção 4 se preferir menos mudança no código.
- **➡️ MINHA ESCOLHA:** 
- **Código:** session.ts:80, auth-context.tsx, lib/session.ts:190

### D285 — Quando um admin tira as permissões de um operador (enquanto ele está logado e trabalhando), o operador fica vendo as informações de antes ou é bloqueado?
- [ ] **vou fazer** · fluxo: Quem faz o quê no sistema (e quando perde acesso)
- **Imagina assim:** Um operador está usando o sistema, separando pedidos. Nesse exato momento, um admin remove o cargo desse operador.
- **Hoje:** O operador continua vendo tudo que via antes (na tela dele) até ele fazer login de novo ou clicar em 'atualizar dados'. Se ele tenta fazer algo que precisa de permissão, o sistema por trás bloqueia e mostra erro.
- **Por que importa:** Pode parecer que o sistema permite (o operador vê as informações), mas depois bloqueia (quando tenta agir). Fica confuso pra o operador. E tem um risco de segurança se o operador vê coisas que não deveria.
- **Opções:** (A) Deixar como está. O operador vê as informações até fazer login de novo — é lag de ~1 sessão, aceitável. → Simples. Mas operador fica confuso quando clica em um botão e é bloqueado.  ·  (B) Avisar o operador em tempo real (quando admin remove o cargo, a tela dele atualiza automaticamente as permissões) → Perfeito pra segurança. Mas exige código novo, um pouco mais complexo.  ·  (C) Atualizar as permissões do operador automaticamente a cada 5 minutos → Simples de codar, mas pode demorar até 5 minutos pra bloquear alguém que deveria ser bloqueado.  ·  (D) Aceitar que é lag temporário (operador vê coisa antiga até próximo login — é seguro no sistema por trás, não é bug) → Mais rápido, menos código. Operador entende que precisa fazer login de novo em caso de mudança urgente.
- **Recomendação:** Opção A (deixar como está) é aceitável se o cenário raramente acontece. Se precisa de segurança imediata, vá pra Opção B (atualizar em tempo real). Opção C é um meio termo bom.
- **➡️ MINHA ESCOLHA:** 
- **Código:** auth-context.tsx:294-307

### D286 — Pode um operador ficar SEM nenhum cargo? (deixando ele 'órfão')
- [ ] **vou fazer** · fluxo: Quem faz o quê no sistema (e quando perde acesso)
- **Imagina assim:** Um admin abre a tela de editar operador e remove todos os cargos (deixa a lista vazia) — salva.
- **Hoje:** O sistema deixa fazer isso. O operador fica registrado no sistema mas sem acesso a nada. A tela mostra um aviso vermelho 'sem nenhum cargo'.
- **Por que importa:** É risco de confusão. Depois não fica claro: foi deliberado (operador suspenso temporariamente)? Ou foi um clique acidental do admin?
- **Opções:** (A) Permitir, e entender como 'suspender o operador temporariamente' (sim, pode ficar sem cargo) → Flexível. Mas exige que admin DOCUMENTE por quê (campo 'motivo da suspensão').  ·  (B) Bloquear no sistema. Exigir que operador tenha SEMPRE pelo menos 1 cargo. → Evita acidentes. Mas se precisa suspender, tem que deletar o usuário (mais drástico).  ·  (C) Permitir, mas marcar o usuário como 'inativo' automaticamente quando fica sem cargo → Mais explícito. Fica claro que o operador está desativado.
- **Recomendação:** Opção A (permitir, mas documentar). Senão vá pra Opção C (marcar como inativo).
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:36-38


## Tema: Devoluções (11)

### D287 — Se o operador classifica 5 itens como bons, mas depois descobre que 1 estava quebrado, pode desfazer só o item quebrado ou precisa desfazer tudo e reclassificar?
- [ ] **vou fazer** · fluxo: Recebimento e classificação de devoluções
- **Imagina assim:** Você recebe uma devolução com 5 peças. Operador escaneia e marca como 'íntegro'. Depois, descobre 1 quebrada. Quer remover só essa 1 da classificação anterior.
- **Hoje:** O sistema não permite. Se você quer mudar, tem que desfazer TUDO (as 5 peças) e reclassificar 4 como boas e 1 como quebrada. Precisa fazer 2 registros separados no sistema.
- **Por que importa:** Quanto mais fácil o operador consertar, menos erro no estoque. Se ficar complicado, ele deixa passar ou desiste.
- **Opções:** (A) Permitir estorno parcial (desfazer só a peça quebrada) → Operador conserta rápido. Sistema fica mais simples de usar. Requer mudança no código.  ·  (B) Manter como está (desfazer tudo, reclassificar em 2 vezes) → Simples de manter. Operador reclama da demora.
- **Recomendação:** Depende do volume de erros que você vê. Se operador está sempre corrigindo classificação, investe em estorno parcial. Se é raro, deixa como está.
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:413-485

### D288 — O sistema consegue rastrear qual empresa vendeu o item originalmente?
- [ ] **vou fazer** · fluxo: Recebimento e classificação de devoluções
- **Imagina assim:** Uma devolução chega. O sistema tenta descobrir: qual empresa vendeu isso? Procura no pedido antigo, mas o dado não está lá.
- **Hoje:** O sistema não consegue resolver quem vendeu. Deixa em branco (sem empresa). O histórico fica incompleto — você não sabe de quem foi a venda.
- **Por que importa:** Auditoria. Se um cliente reclama, você não consegue rastrear: foi a empresa A ou B que vendeu? Sem isso, fica vago.
- **Opções:** (A) Pedir que operador escolha a empresa manualmente → Auditoria fica completa. Operador tem mais 1 clique.  ·  (B) Deixar em branco → Mais rápido. Auditoria sofre.
- **Recomendação:** Pedir ao operador. Leva 1 segundo e resolve problema de rastreamento.
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:139-165

### D289 — Quando o item volta ao estoque, ele volta com o preço de custo original?
- [ ] **vou fazer** · fluxo: Recebimento e classificação de devoluções
- **Imagina assim:** Um item foi vendido há 3 meses por R$ 100 (custou R$ 50). Agora devolve. O sistema tenta descobrir o custo antigo para atualizar a média. Mas o dado antigo está vazio.
- **Hoje:** O item volta ao estoque sem custo. O custo médio do produto NÃO é recalculado. O preço global fica igual.
- **Por que importa:** Se o custo original era diferente, a margem está errada. A hora que vender de novo, o preço pode estar fora.
- **Opções:** (A) Avisar operador que custo antigo não existe, pedir input → Dados ficam precisos. Operador tem mais 1 clique para itens antigos.  ·  (B) Deixar em branco (como está) → Rápido. Preço global fica aproximado.  ·  (C) Recalcular custo retroativamente (sistema descobre o custo médio do período) → Mais preciso. Desenvolvimento mais caro.
- **Recomendação:** Opção 1 se item antigo com custo vazio é comum. Opção 2 se é raro (menos de 5% das devoluções).
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:179-188, ledger.ts:107-122

### D290 — Quando um pedido está preso (falta estoque), e depois chega uma devolução que libera o estoque, o pedido retoma sozinho ou fica esperando ordem do operador?
- [ ] **vou fazer** · fluxo: Recebimento de devolução de cliente e volta ao estoque
- **Imagina assim:** Decisão 1
- **Hoje:** O sistema roda uma tarefa que olha pra devolução NAQUELE MOMENTO e marca os pedidos velhos que estavam presos ('aqueles que precisam de parachoques'). Eles ganham uma bandeira: 'saldo apareceu'. O operador depois precisa clicar um botão no painel pra reativar esses pedidos. Mas se um NOVO pedido entrou DEPOIS da devolução, ele não ganha a bandeira — fica na fila de espera. O operador só percebe quando der a verificação de reconhecimento (pode levar minutos ou horas, não confirmei).
- **Por que importa:** Seus pedidos presos podem ficar esperando horas mesmo que tenha estoque disponível. Cliente acha que pedido está parado sem motivo. Você não aproveita o estoque que chegou pra desbloquear logo os pedidos.
- **Opções:** (A) Rodar a verificação de reconhecimento a cada novo pedido que chega → Qualquer pedido novo é desbloqueado imediatamente se houver estoque. Mais rápido, mais processamento no sistema.  ·  (B) Deixar como está (operador clica o botão manualmente) → Operador vê pedidos presos e aprova quando acha necessário. Mais controle manual, menos automatismo.  ·  (C) Rodar verificação cada 5 minutos (em vez de 15) → Balanço: mais rápido que agora, mas não instantâneo. Menos processamento que opção 1.
- **Recomendação:** Opção 1 (rodar a cada novo pedido). Seus pedidos fluem assim que tem estoque, sem atraso. Melhor pra cliente, melhor pra você.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:234-263, src/lib/wms/varredura-validacao-oc.ts

### D291 — Um cliente devolveu parachoques errado (pediu A, devolveu B) — ele quer A. O sistema faz o quê?
- [ ] **vou fazer** · fluxo: Recebimento de devolução de cliente e volta ao estoque
- **Imagina assim:** Decisão 3
- **Hoje:** O operador marca como 'troca SKU'. O sistema recebe o B devolvido (entrada) e registra. Depois, em outro fluxo, alguém tem que verificar e rebalancear: tirar B, dar A ao cliente. Mas se ninguém rodar esse fluxo (não confirmei se é automático ou manual), o B fica no estoque indefinidamente. Cliente não recebe o A que pediu.
- **Por que importa:** Cliente fica sem o que pediu. Seu estoque fica com peça errada que ninguém usará. Fidelidade do cliente cai.
- **Opções:** (A) Processamento automático: sistema separa B, pede ao fornecedor A, envia pro cliente assim que A chega → Cliente recebe A rápido. Você não esquece. Depende do fornecedor ter A em estoque.  ·  (B) Processamento manual: operador vê a troca, faz a rebalanceamento manualmente → Você controla cada passo. Não é automático — pode demorar, pode esquecer.  ·  (C) Deixar B no estoque, avisar cliente: 'B recebido, rebalanceamento em breve' → Cliente sabe que você recebeu. Pode dar tempo pra providenciar A. Transparência.
- **Recomendação:** Opção 1 (automático). Assim que marca 'troca SKU', o sistema já separa B e começa a rebalancear pra A. Cliente recebe rápido, você não perde rastro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/devolucoes.ts:305-322

### D292 — Na devolução, de quem é o produto original? Como sabe?
- [ ] **vou fazer** · fluxo: Recebimento de devolução de cliente e volta ao estoque
- **Imagina assim:** Decisão 4
- **Hoje:** O sistema tenta achar quem era o vendedor original (se você vende pra marketplace A, marketplace B, ou direto). Busca a nota fiscal original, acha o pedido, pega a empresa de origem. Mas se o pedido foi de antigamente (antes de uma mudança no sistema), a empresa fica em branco (vazio). Devolução entra, mas ninguém sabe de quem era.
- **Por que importa:** Você não consegue rastrear: 'esse parachoques que voltou era de qual marketplace?'. Seus relatórios quebram. Auditor acha estranho. Custo do produto fica errado também.
- **Opções:** (A) Pedir operador que selecione a empresa (dropdown) ao receber devolução → Sem ambiguidade. Operador sabia de quem era. Mais um passo no processo.  ·  (B) Usar regra inteligente: se não achar pedido, tira da empresa padrão (ex: você mesmo, não marketplace) → Sempre preenche. Pode errar (marketplace A devolveu, mas registra como seu). Precisa revisar depois.  ·  (C) Deixar em branco, avisar auditoria depois → Sistema anda, mas relatório fica incompleto. Risco de descordenação.
- **Recomendação:** Opção 1 (operador escolhe). Leva um clique a mais, mas garante que você sabe de quem era. Sem confusão depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/devolucoes.ts:142-165

### D293 — Quando chegam 3 parachoques de devolução e 2 pedidos diferentes estão presos (um precisa de 5, outro de 2), qual pedido pega antes?
- [ ] **vou fazer** · fluxo: Recebimento de devolução de cliente e volta ao estoque
- **Imagina assim:** Decisão 5
- **Hoje:** O sistema usa ordem: primeiro que entrou, primeiro que sai. Pedido A chegou há 2 horas preso (precisa 5). Pedido B chegou há 5 minutos preso (precisa 2). Devolução +3 entra. Sistema olha pra ordem: A é mais velho. Mas A precisa de 5, e só tem 3 — não cobre. Então sistema desbloquearia B (precisa 2, tem 3). Depois disso, A continua preso (falta 3 pro A). Se não vier mais estoque, A fica travado.
- **Por que importa:** Pedido mais velho pode ficar preso indefinidamente mesmo que você receba estoque novo. Cliente do pedido A fica aguardando, cliente do pedido B sai na frente. Fila fica desigual.
- **Opções:** (A) Respeitar ordem estrita: A é mais velho, tenta cobrir A primeiro mesmo que falte → Ordem justa de quem chegou antes. Pedido B espera. Mais justo, pode ser mais lento.  ·  (B) Priorizar quem completa com menos estoque (B primeiro, depois A) → Mais pedidos completados rapidamente. Fila menos travada. Pode ser injusto com quem chegou primeiro.  ·  (C) Deixar operador escolher (flexibilidade manual) → Você controla. Pode ser lento (operador esquece, clica errado).
- **Recomendação:** Opção 1 (ordem estrita). Mantém ordem justa. Se A está preso, A tem prioridade quando estoque chega. Mais previsível pra cliente.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:234-263, src/lib/wms/varredura-validacao-oc.ts

### D294 — O que fazer quando não existe uma prateleira para guardar uma devolução avariada?
- [ ] **vou fazer** · fluxo: Devolução de mercadoria avariada
- **Imagina assim:** Ao classificar o item devolvido (íntegro, avariado ou troca)
- **Hoje:** Se o galpão não tem uma prateleira destinada para 'quarentena', o sistema não consegue transferir a devolução. Como fallback, ele registra uma saída com origem marcada como 'ajuste manual' para remover o estoque que tinha entrado.
- **Por que importa:** A devolução avariada entra no estoque (por exemplo: 1 unidade na prateleira A-01-09), mas depois sai novamente via ajuste manual no mesmo evento. Não fica claro se foi realmente recebida ou se desapareceu. A trilha fica registrada no histórico, mas sem um lugar específico para guardar a avaria.
- **Opções:** (A) Continuar com o fallback atual (entra e sai no mesmo movimento, sem quarentena) → A devolução avariada não fica fisicamente guardada em nenhum lugar, mas o sistema registra tudo no histórico. Funciona se quiser apenas rastrear, não armazenar.  ·  (B) Exigir que SEMPRE exista uma prateleira de quarentena cadastrada → Força a empresa a ter um lugar físico para guardar devoluções avariadas. A devolução fica lá até ser decidido o que fazer (enviar de volta ao fornecedor, descartar, etc).
- **Recomendação:** Exigir quarentena. Mesmo que temporária, ter um lugar para guardar devolução avariada facilita rastreamento, decisão de reembolso, e reclame com fornecedor. Sem lugar físico, fica impossível auditar depois.
- **➡️ MINHA ESCOLHA:** 
- **Código:** (buscar pelo fluxo "Devolução de mercadoria avariada")

### D295 — Quando desiste de marcar como danificado, deve devolver tudo em uma operação única ou pode devolver em etapas?
- [ ] **vou fazer** · fluxo: Devolução com Troca de Peça
- **Imagina assim:** Operador classificou uma devolução como danificado (B). Sistema fez 3 movimentos: 1) entrou do recebimento, 2) saiu do recebimento, 3) entrou em quarentena. Agora quer desistir (desclassificar).
- **Hoje:** Sistema desfaz os 3 movimentos, cada um separado. Se o 2º falhar, o 1º já foi desfeito e fica inconsistente.
- **Por que importa:** Se uma operação falha no meio, fica confuso: estoque apartado em um lugar mas registro em outro. Operador não sabe se tudo funcionou ou ficou pelado.
- **Opções:** (A) Fazer tudo junto (atômico): ou reverte os 3 movimentos inteiros, ou falha completamente sem fazer nenhum — não fica no meio do caminho → Ou funciona 100% (os 3 voltam) ou volta pro estado anterior. Nunca fica inconsistente.  ·  (B) Deixar como está (desfaz um por um, se algum falha avisa depois) → Mais simples de programar, mas risco de ficar com estoque em lugar errado se cair internet ou erro no meio.
- **Recomendação:** Fazer tudo junto (opção 1). É a forma confiável. Sistema nunca fica em situação 'meia boca'.
- **➡️ MINHA ESCOLHA:** 
- **Código:** devolucoes.ts:453-467

### D296 — O relatório deve mostrar devoluções para fornecedor quando elas são 'recebidas de volta', ou só quando são 'enviadas'?
- [ ] **vou fazer** · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Cenário: você envia 10 peças de volta para o fornecedor (saída do estoque). Dias depois, fornecedor recebe e registra no seu sistema. Qual dessas duas ações o relatório deve rastrear?
- **Hoje:** Relatório mostra só quando você envia (saída). Quando a devolução é recebida pelo fornecedor (entrada confirmatória), o sistema não inclui no relatório de movimentações.
- **Por que importa:** Se você quer saber 'quantas peças saíram de verdade', relatório está certo mostrando saída. Mas se quer auditoria completa de devolução (enviei E foi confirmado que receberam), fica incompleto. A entrada de confirmação fica invisível.
- **Opções:** (A) Mostrar ambas: envio + confirmação de recebimento (incluir os dois tipos de devolução) → Auditoria 100% — você vê ciclo completo (envio → recebimento confirmado). Relatório fica mais rico, mas com mais linhas.  ·  (B) Mostrar só envio (como está agora): devolução é uma saída do seu estoque → Foco na ação que você controla (despacho de devolução). Confirmação do fornecedor é problema dele. Relatório mais limpo.  ·  (C) Dois relatórios: um de devolução fiscal (envio), outro de devolução física (recebimento) → Flexível. Usuário escolhe o que quer ver. Mas fica complexo — dois relatórios em vez de um.
- **Recomendação:** Opção 1: incluir ambas (envio e recebimento de devolução). Auditoria completa e mais valioso. Só precisa documentar claramente que são 'dois passos' do mesmo ciclo de devolução.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/relatorios/movs-por-empresa/route.ts:54-61

### D297 — Quando um pedido volta (devolução), o histórico de performance continua contando aquele pedido como sucesso?
- [ ] **vou fazer** · fluxo: Painel de Acompanhamento de Fluxo (produtividade e atrasos por etapa)
- **Imagina assim:** Pedido P-456 saiu do galpão em 2 horas (embalagem rápida, dentro da meta). Depois cliente devolveu. Sistema criou registro de devolução, devolveu o estoque pro monte. Mas o histórico de tempos (P90 de embalagem) ainda conta aquele pedido como '2 horas de sucesso'.
- **Hoje:** O sistema marca o pedido como embalado quando sai do galpão. Se depois vira devolução, o histórico de tempos não é ajustado. Continua contando como se tivesse saído de verdade.
- **Por que importa:** Se você usa 'velocidade de embalagem' pra medir se o galpão está bom ou ruim, um pedido que voltou não deveria contar como sucesso. Ou você está vendo performance fake (pedidos que voltaram parecem rápidos), ou está perdendo o verdadeiro tempo de vida do pedido (entrou, saiu em 2h, voltou em dia 5 = tempo total = 5 dias, não 2 horas).
- **Opções:** (A) Histórico ignora pedidos que têm devolução: não conta aquele P-456 nos tempos de embalagem. Só conta os que de verdade saíram e ficaram saindo. → Histórico fica limpo, mostra só o que funcionou. Performance real. Mas se 30% dos pedidos viram devolução depois, histórico fica pequeno e pode ser enviesado.  ·  (B) Histórico conta pedido P-456 duas vezes: uma como '2h de separação/embalagem', depois como 'X dias de tempo total de vida (entrada até devolução)'. → Visão mais honesta: você vê que P-456 foi rápido na embalagem, mas o negócio levou 5 dias pra resolver. Mais informação, mas mais complexo.  ·  (C) Deixa como está: histórico conta tudo como foi, devoluções não mexem no passado. → Mais simples de codificar. Mas métrica fica mentirosa (performance boa vs realidade ruim).
- **Recomendação:** Opção 1 é melhor pra start: filtra devoluções do histórico de tempos de separação/embalagem. Se depois precisarem de mais nuança (tempo de vida total), criam uma métrica separada. Por enquanto: devolução = tira do histórico de performance de galpão.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/concluir/route.ts / supabase/migrations/20260515_wms_insights_rpcs.sql:250-279


## Tema: Saldo e disponibilidade de estoque (7)

### D298 — O que fazer com produtos que ninguém vende? Produto com zero saída em 30 dias, mas ainda tem estoque guardado — deveria avisar o dono?
- [ ] **vou fazer** · fluxo: Atualização de cobertura de estoque
- **Imagina assim:** Produto Y no galpão SP: 50 unidades em estoque, mas nenhuma venda nos últimos 30 dias. O sistema marca como 'sem giro'.
- **Hoje:** O sistema mostra a quantidade (50 un) e o status 'sem giro', mas não toma nenhuma ação automática. Fica ali, ocupando prateleira, até alguém decidir o que fazer.
- **Por que importa:** Produto parado demais vira custo — ocupa espaço, pode vencer validade, ou virou obsoleto. Dinheiro preso. Precisa de uma decisão: vai vender com desconto? vai devolver pro fornecedor? vai descontinuar?
- **Opções:** (A) Deixar como está: apenas sinalizar 'sem giro' pra o gerente revisar quando tiver tempo. → Sem ação automática. Depende de alguém notar e tomar iniciativa. Risco: produto fica parado meses.  ·  (B) Enviar alerta após 30 dias sem venda: 'Produto Y parado 1 mês — revisar fornecedor ou descontinuar?' → Aviso proativo no email/dashboard. Gerente tem chance de agir rápido antes de virar problema maior.  ·  (C) Enviar alerta após 90 dias sem venda: apenas para produtos realmente 'sepultados'. → Menos avisos, mas corre risco de produto ficar muito tempo esquecido.
- **Recomendação:** Escolha opção 2 (alerta após 30 dias). Ajusta o timing conforme experiência: se achar que 30 é cedo, suba pra 45 ou 60 dias. O importante é ter uma rotina que tira esses produtos do esquecimento e força uma decisão de negócio.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260520f_mviews.sql:64-76

### D299 — Se o operador vê o estoque de uma peça numa hora, volta depois e reabre, a informação deve estar travada no momento que ele viu ou sempre atualizada?
- [ ] **vou fazer** · fluxo: Busca de peças equivalentes e compatibilidades
- **Imagina assim:** Hora 9:00 — BRAKE-A em Curitiba mostra 100 unidades. Operador fecha a aba. Hora 10:00 — a loja vende 50 unidades via Tiny. Operador reabre e vê 150 unidades.
- **Hoje:** Toda vez que o operador atualiza a página ou faz um clique, o sistema busca o número ATUAL de peças na loja (Tiny). Não fica salvo um "snapshot" de quando foi consultado.
- **Por que importa:** O operador pode tomar uma decisão errada. Ele acreditava que havia 100 unidades e baseou um pedido nisso. Uma hora depois, a loja vendeu 50 e ele não sabe. Se recomeça com 150 na cabeça, escolhe mal quais peças guardar ou separar para qual pedido.
- **Opções:** (A) Manter como está: estoque sempre atualizado em tempo real. → Operador vê o número certo AGORA, mas fica confuso se demorou pra refrescar.  ·  (B) Guardar um 'snapshot' do momento que o operador entrou na página — mostra "consultado às 9:05" para ele saber que a informação é de 1 hora atrás. → Operador fica ciente de que o número pode ter mudado e decide se recarrega ou não.  ·  (C) Tracar o estoque por 1 hora — operador vê o número de quando olhou, não muda até 1 hora passar. → Operador trabalha com o número fixo, mas pode trabalhar com informação desatualizada se não recarregar.
- **Recomendação:** Mostra o número sempre atualizado (opção 1) e adiciona um rótulo pequeno: 'consultado agora'. Se operador suspeita que mudou, clica um botão para recarregar e vê a data/hora da última consulta.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/cross/catalogo-queries.ts:424-430, src/app/api/wms/cross/produtos/[sku]/estoque/route.ts:40-41

### D300 — Quando alguém faz um ajuste manual no estoque (sem vincular a uma empresa), onde esse ajuste aparece no relatório?
- [ ] **vou fazer** · fluxo: Relatório de quantidade em estoque por empresa
- **Imagina assim:** O gestor identifica uma diferença de 100 unidades na contagem física. Cria um ajuste 'entrada manual' no sistema mas não marca qual empresa é dona desse estoque.
- **Hoje:** O sistema aceita e anota os 100 itens. Mas no relatório de saldos por empresa, essa entrada desaparece. Não aparece em nenhuma linha porque não tem empresa marcada. Porém, os 100 itens realmente afetam o saldo total (a quantidade real que o sistema acha que tem).
- **Por que importa:** Cria confusão: o relatório não bate com a realidade de estoque. Você olha o relatório, vê X unidades, mas se somar com físico da câmera sobra diferença que ninguém entende. Além disso, não fica registrado: 'aqueles 100 vieram de onde?'.
- **Opções:** (A) Ajustes órfãos aparecem numa linha 'Sem empresa' no relatório. → Visibilidade total. Você vê tudo que entrou sem vínculo e consegue rastrear depois.  ·  (B) Forçar sistema a rejeitar ajuste sem empresa: obriga o operador a escolher uma empresa sempre. → Nenhum ajuste fica invisível. Tudo tem dono. Mais trabalho no dia-a-dia mas rastreabilidade perfeita.  ·  (C) Deixar como está, mas avisar que relatório de empresa não inclui esses valores. → Sem mudança, só documentar que relatório é parcial. Continua confuso.
- **Recomendação:** Forçar vínculo a empresa (opção 2). Ajuste manual é raro e importante — vale 2 cliques a mais do operador pra ter rastreabilidade. Depois você consegue entender de verdade: ajuste foi reposição? Acerto de diferença? Que empresa?
- **➡️ MINHA ESCOLHA:** 
- **Código:** route.ts:62, ledger.ts

### D301 — Relatório de saldos deve mostrar produtos com zero unidades, ou omiti-los?
- [ ] **vou fazer** · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Um produto foi completamente vendido: entrou 100, saiu 100. Saldo final = 0. Hoje você quer confirmar que foi tudo vendido (limpeza de estoque), mas produto não aparece no relatório.
- **Hoje:** Sistema omite automaticamente produtos com saldo zero — não aparecem no relatório. Você só vê produtos com quantidade positiva.
- **Por que importa:** Se quer confirmar que vazio foi mesmo vendido e não é 'dado perdido', precisa da informação. Invisibilidade causa dúvida (foi vendido? ou ficou pra trás sem lançar?). Auditoria fica incompleta.
- **Opções:** (A) Sempre mostrar zeros: incluir no relatório produtos com saldo=0, diferenciados visualmente → Auditoria transparente — você vê o ciclo completo. Sabe que aquele produto foi vendido tudo. Relatório fica maior, mas informação completa.  ·  (B) Deixar como está: omitir zeros, manter relatório enxuto → Relatório mais leve, só mostra o que há. Mas você tem que ir para outro lugar (histórico detalhado) se quiser confirmar produto com zero.  ·  (C) Checkbox opcional: relatório mostra só positivos por padrão, mas tem opção 'mostrar também zeros' no filtro → Melhor dos dois mundos. Padrão enxuto, mas flexível quando você quer auditoria completa.
- **Recomendação:** Opção 3: padrão omiti zeros (relatório limpo), mas botão 'incluir saldo zero' quando você quer auditoria. Felicidade dos dois lados.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/relatorios/saldos-por-empresa/route.ts:76

### D302 — Quando você vê saldo de um produto que nunca entrou, o relatório mostra ou omite?
- [ ] **vou fazer** · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Produto X: nunca foi comprado, mas de algum jeito tem -5 unidades (ajuste manual ou erro). Relatório de saldos — mostra ou não?
- **Hoje:** Relatório omite — só mostra produtos que tiveram pelo menos uma entrada registrada.
- **Por que importa:** Estoque negativo é anômalia. Se produto nunca entrou mas está negativo, é sinal de erro no sistema ou entrada não lançada. Você quer saber disso para corrigir.
- **Opções:** (A) Mostrar sempre, destacado em vermelho: qualquer produto com movimento aparece, mesmo que saldo=0 ou negativo → Anomalias fica visível. Você vê que tem produto negativo e pode investigar. Seguro.  ·  (B) Omitir (como está): mostra só positivos e nulos, sem negativos de entrada zero → Relatório limpo. Mas anomalia fica invisível — você não sabe que tem produto negativo flutuando.  ·  (C) Relatório de anomalias: criar um relatório separado 'saldos inconsistentes' para produtos com problema → Flexível — você escolhe quando quer auditoria de anomalias. Relatório normal fica limpo.
- **Recomendação:** Opção 1: mostrar sempre, destacado (vermelho ou ícone de aviso). Anomalia não é invisibilidade que se resolve — é informação que você precisa ter.
- **➡️ MINHA ESCOLHA:** 
- **Código:** Implícito em saldos-por-empresa/route.ts

### D303 — Se a prateleira mudou de tipo de picking para quarentena, o sistema que busca estoque pra pedido vai encontrar o estoque lá?
- [ ] **vou fazer** · fluxo: Criar, editar e remover prateleiras
- **Imagina assim:** Prateleira A tinha 100 unidades de Produto X, tipo picking. Tipo muda para quarentena. Depois vem pedido querendo Produto X. O sistema por trás procura estoque — encontra A com 100 unidades mas tipo é quarentena. Aloca ou não?
- **Hoje:** Não fica claro como o sistema que busca estoque funciona — depende se ele filtra por tipo de prateleira ou só vê saldo. Se filtra por tipo, não acha. Se não filtra, acha mas separa de lugar errado (prateleira de quarentena é zona diferente de picking).
- **Por que importa:** Se o sistema achar estoque em quarentena quando procura por picking, vai mandar separador pra quarentena — lugar errado, confunde operação. Se não achar, estoque fica invisível pro pedido (100 unidades existem mas não são usadas).
- **Opções:** (A) Sistema ignora tipo — pega estoque onde estiver (picking, quarentena, etc) → Estoque nunca fica invisível, mas confunde operador (busca em picking, acha em quarentena)  ·  (B) Sistema filtra por tipo — só busca em picking e overstock, quarentena é zona separada → Operação clara (cada zona tem seu propósito), mas precisa trocar tipo de volta ou mover estoque antes de vender
- **Recomendação:** Define qual é o propósito de cada tipo: picking é pra vender, quarentena é pra estoque em dúvida. Se muda tipo com estoque, o sistema que busca deve avisar que tipo mudou ou bloquear a mudança. Escolha: zona mista (ignora tipo) ou zona separada (filtra tipo)?
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/roteamento.ts

### D304 — Produto novo (zero vendas) aparece no painel como 'sem giro' — deve alertar ou não?
- [ ] **vou fazer** · fluxo: Painel de Visibilidade (indicadores chave, gráficos, resumo rápido)
- **Imagina assim:** Novo produto chegou ontem com 50 unidades. Sistema está ok, estoque ok. Mas é novo, nunca vendeu. Painel mostra no card 'Produtos sem giro nos últimos 30 dias: 1'. Dono vê e pensa 'por que esse produto tá aqui? Ele acaba de chegar.' Não é um problema — é esperado. Mas polui o painel com um falso alarme.
- **Hoje:** Painel mostra 'Sem giro 30d: 1' junto com 'Crítico: 3' e 'Risco: 5'. Sem diferenciação. Tudo tem o mesmo peso visual.
- **Por que importa:** Dono quer focar em situações reais que precisam ação (crítico, risco). Produtos novos não precisam ação — são esperados ter zero giro. Se encher o painel com informação não-acionável, dono ignora tudo.
- **Opções:** (A) Excluir 'sem giro' do painel principal. Criar uma aba separada 'Informativos' pra produtos novos/sem giro. → Painel clean, só problemas reais. Produtos novos ainda são visíveis mas em lugar apropriado.  ·  (B) Manter no painel, mas com estilo diferente (cinza, sem ícone de alerta). Deixar claro que é 'informativo, não alarme'. → Tudo em um lugar. Visual diferencia. Dono sabe que não é urgente.  ·  (C) Adicionar lógica: se produto < 7 dias no estoque E zero giro, marcar como 'Novo' em vez de 'Sem giro'. → Contexto automático. Sistema sabe que é novo, não marca como problema. Mais inteligente.
- **Recomendação:** Opção 3 com fallback pra 1: sistema marca 'Novo' pra produtos de entrada recente (< 7 dias) + zero giro. Se não conseguir rastrear entrada, cria aba 'Informativos'. Dono vê painel clean com só problemas reais.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/dashboard-geral.ts:84, supabase/migrations/20260605_wms_excecoes_dashboards.sql:68-75


## Tema: Custo e preço das peças (6)

### D305 — Produto sem preço: por onde começa?
- [ ] **vou fazer** · fluxo: Quando um pedido novo chega e o sistema decide de qual galpão sai
- **Imagina assim:** Um pedido aprova com um produto que não tem preço unitário (custo) registrado no sistema.
- **Hoje:** Sistema processa o pedido normalmente e cria a reserva, mas sem informação de preço. Mais tarde, quando entra a nota fiscal da venda, o sistema tenta atualizar o custo médio, mas se a nota fiscal também não informar o preço, ele fica vazio. Nenhum valor de lucro pode ser calculado depois.
- **Por que importa:** Lucro não pode ser calculado se não souber o custo. Relatório de rentabilidade fica errado. Você não sabe se aquele pedido foi lucrativo ou foi prejuízo.
- **Opções:** (A) Obrigar preço desde o primeiro pedido → Todo produto precisa ter preço antes de qualquer movimentação. Mais trabalhoso no cadastro, mas zero produto sem custo depois.  ·  (B) Deixar produto rodar sem custo e atualizar depois quando a nota chegar → Produto sai rápido, menos burocracia. Risco: nota nunca chega e produto fica sem custo pra sempre.  ·  (C) Aceitar produto sem custo no pedido, mas obrigar no primeiro lançamento de entrada (NF de compra) → Meio termo. Produto pode sair no pedido, mas quando chega a mercadoria, tem que ter preço.
- **Recomendação:** Opção 1 (se vende muito e gira rápido) ou Opção 3 (se estoque demora a chegar). Opção 2 deixa risco aberto.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/ledger.ts:98-113

### D306 — O que fazer com o custo da mercadoria quando ele está em branco ou é zero?
- [ ] **vou fazer** · fluxo: Recebimento de Compra de Fornecedor
- **Imagina assim:** Operador recebe 100 unidades de um produto, mas esquece de preencher o custo unitário (ou coloca zero). Precisa desse custo pra saber quanto o estoque vale.
- **Hoje:** O sistema aceita e deixa em branco. O custo médio do estoque não é calculado. Fica um 'buraco' nos dados de valor do inventário.
- **Por que importa:** Sem custo, você não sabe quanto custa o estoque no seu livro contábil. Relatório de valor do estoque fica errado e auditoria não bate.
- **Opções:** (A) Exigir obrigatoriamente: bloqueio se não preencher o custo → Operador não consegue receber sem custo. Mais seguro, mas pode travar se não souber o valor.  ·  (B) Carregar do pedido de compra automaticamente: se a compra tem preço, usar esse → Operador não precisa digitar, menos erro, mais rápido  ·  (C) Permitir editar depois na guarda: recebe agora, completa o custo na pendência → Não bloqueia a entrada, mas adiciona uma etapa de conferência manual
- **Recomendação:** Carregar do pedido de compra automaticamente. Se não tiver custo lá também, então exigir preenchimento manual no recebimento. Menos digitação, menos erro.
- **➡️ MINHA ESCOLHA:** 
- **Código:** receber-oc.ts:152 e ledger.ts:107-122

### D307 — Quando você desfaz um ajuste de entrada que tinha preço errado, o custo médio volta ou fica congelado?
- [ ] **vou fazer** · fluxo: Desfazer um ajuste de estoque
- **Imagina assim:** Você fez um ajuste entrada de 10 unidades a R$ 50 cada. Depois descobre que era pra ser R$ 5 (digitou errado — faltou zero). Desfaz o ajuste. O sistema volta o saldo pra zero, mas o preço médio fica preso em R$ 50. Quando chega um produto novo a R$ 5, o sistema recalcula a média como (0 × R$ 50 + novo × R$ 5) ÷ novo = R$ 5 (porque saldo anterior era zero).
- **Hoje:** Saldo volta a zero, mas o custo médio histórico fica congelado em R$ 50. Só muda quando entra produto novo — aí recalcula do zero porque não há saldo anterior.
- **Por que importa:** Se você quiser saber 'quanto custou em média os produtos que tenho agora', o número fica errado até chegar mercadoria nova. Risco: relatório de custo erra por dias.
- **Opções:** (A) Deixar como está (custo congelado até próx entrada). O ajuste desfeito é história — não refaz o passado. → Simples de implementar. Histórico fica como é (imutável). Relatório de custo pode ficar temporariamente errado se alguém fez ajuste errado e desfeito.  ·  (B) Apagar o ajuste inteiro do histórico (tipo nunca tivesse existido). Custo volta ao que era antes. → Auditoria perde registro de que alguém mexeu. Risco compliance (você fez desfazer, não ficou documentado).  ·  (C) Deixar o custo como está, mas avisar: 'Custo médio permanece em R$ 50 até próxima entrada'. Operador sabe que o relatório de hoje tá off. → Transparente. Risco: operador ignora aviso e faz decisão de preço errada.
- **Recomendação:** Opção 1. Mantenha o histórico intacto — auditoria agradece. Se custo ficar errado por dias, é culpa de quem digitou errado, não do sistema. Próxima entrada corrige automático.
- **➡️ MINHA ESCOLHA:** 
- **Código:** ACD-003 / decisão: custo_medio post-desfazer

### D308 — Quando você descobre que faltou registrar uma entrada (por exemplo, encontrou estoque perdido), deve atualizar o custo médio?
- [ ] **vou fazer** · fluxo: Custo médio do produto
- **Imagina assim:** Você encontrou 8 unidades de um produto perdidas no galpão. Digita no sistema: entrada manual, 8 unidades, R$ 10 cada.
- **Hoje:** O sistema registra as 8 unidades no saldo, mas ignora o custo R$ 10. Deixa o custo médio como estava antes (não muda).
- **Por que importa:** Se você informa o custo e o sistema ignora, você acha que registrou tudo — mas não registrou. O custo da média fica enganoso.
- **Opções:** (A) Sim, atualizar sempre o custo quando tem entrada manual com custo informado → Consistente — entrada é entrada, quer seja com nota fiscal ou encontrada no chão. Custo médio sempre reflete tudo.  ·  (B) Não, entrada manual (achado) não conta no custo — só notas fiscais contam → Mais conservador — você não infla o custo com achados. Mas precisa avisar que o custo foi ignorado (senão fica confuso).  ·  (C) Deixar como está — ignora custo de entrada manual → Status quo. Você sabe que é limitação, mas continua confuso.
- **Recomendação:** Opção 1: Se operador digita custo na entrada manual, o sistema deveria usar. Pelo menos avisar bem claro: 'Custo informado: R$ 10, será usado na média'. Se fosse achado sem custo, deixa blank e sistema ignora.
- **➡️ MINHA ESCOLHA:** 
- **Código:** 20260526_custo_medio_ajuste_manual.sql:1-11

### D309 — Quando o mesmo produto é comprado em datas diferentes com preços diferentes, como o relatório deve mostrar?
- [ ] **vou fazer** · fluxo: Relatório de Entradas e Saídas por Empresa
- **Imagina assim:** Produto comprado em janeiro por R$10/un (10 unidades = R$100 total), comprado em junho por R$15/un (10 unidades = R$150 total). Período janeiro-junho: total 20 un, R$250. Mas qual era o preço?
- **Hoje:** Relatório mostra só o total: 20 unidades, R$250. Não mostra que uma leva era mais cara que a outra. Se exportar para spreadsheet, vem 1 linha sem detalhe de preço.
- **Por que importa:** Você quer saber se o preço subiu (para negociar melhor com fornecedor, ou entender custo). Sem breakdown por compra, não consegue. Só vê o total.
- **Opções:** (A) Adicionar colunas de preço no export: preço mínimo, máximo, média. Ex: 20 un | R$250 | R$10 mín | R$15 máx | R$12,50 média → Você vê flutuação de preço direto no export. Simples, direto ao ponto. Bom para gestão de custo.  ·  (B) Detalhe por entrada: cada compra em linha separada. Ex: 10 un (jan) R$100 | 10 un (jun) R$150 → Total transparência. Você vê cada compra e seu preço. Mas relatório fica maior — muitas linhas se muitas compras.  ·  (C) Deixar como está: mostra só total, sem detalhe de preço → Simples, relatório leve. Mas sem informação de flutuação de preço — você fica cego para custo.  ·  (D) Link para relatório extra: relatório principal mostra total, mas tem botão 'ver detalhe de custo' que leva a outro relatório com histórico de compra → Flexível. Padrão simples, detalhe sob demanda. Bom para quem quer informação rápida ou detalhe profundo.
- **Recomendação:** Opção 1 ou 4: adicionar colunas de preço mínimo/máximo/média no export, ou link para detalhe. Você consegue entender variação sem poluir o relatório principal.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/relatorios/movs-por-empresa/route.ts (custo unitário)

### D310 — Qual custo usar quando acertar estoque: o do lançamento ou o da compra real?
- [ ] **vou fazer** · fluxo: Acertar estoque retroativo com a compra real
- **Imagina assim:** Operador lança retroativo de 10 peças com custo 'adivinhação' (R$ 100 cada). Depois acha a nota de verdade, que custou R$ 90. Qual valor usa pra atualizar custo médio do estoque?
- **Hoje:** Sistema registra a nota com custo 100, muda custo médio. Depois, quando acerta, não recalcula (mantém 100 como registro, não muda pra 90 de verdade).
- **Por que importa:** Custo médio errado = margem errada = preço de venda errado = lucro errado.
- **Opções:** (A) Usar custo da compra real (90) e recalcular custo médio quando acertar. → Custo médio fica correto desde que você achar a NF verdadeira.  ·  (B) Aceitar custo do lançamento como 'placeholder' — não muda depois (360 dias de custo errado até fechar o mês). → Mais simples pro sistema, mas custo médio errado até você ajustar manual.  ·  (C) Permitir operador digitar o custo real ANTES de acertar (ou depois de acertar). → Mais flexível, menos automático.
- **Recomendação:** Opção 1 — se for achar a NF, usa ela de verdade; senão, o sistema está fazendo adivinhação.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:526-540


## Tema: Para onde o pedido vai (roteamento e galpão) (6)

### D311 — Empresa sem galpão preferencial: onde roteamos?
- [ ] **vou fazer** · fluxo: Quando um pedido novo chega e o sistema decide de qual galpão sai
- **Imagina assim:** Uma empresa vendedora não tem nenhum galpão definido como preferido (casa/home). Sistema precisa decidir onde colocar cada pedido.
- **Hoje:** Sistema ignora preferência geográfica (porque não há). Escolhe o primeiro galpão que conseguir cobrir 100% do pedido. Marca como 'próprio' mesmo que não seja galpão de verdade da empresa.
- **Por que importa:** Se empresa não tem galpão definido, talvez não deveria estar vendendo. Ou o roteamento fica aleatório e perde qualidade (pode enviar de longe).
- **Opções:** (A) Sempre marcar como 'próprio' em qualquer galpão (hoje) → Rápido, automático. Risco: estoque sai de longe, frete fica caro, cliente fica insatisfeito.  ·  (B) Deixar pedido pendente até alguém escolher manualmente qual galpão → Mais seguro, mais trabalho manual. Operador decide melhor.  ·  (C) Obrigar empresa ter galpão preferido antes de qualquer venda → Cadastro correto desde o inicio. Roteamento automático fica confiável.
- **Recomendação:** Opção 3. Cadastro correto antes de vender. Opção 2 se precisar de transitório. Opção 1 deixa risco.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/roteamento.ts:146-165

### D312 — O que fazer quando um operador clica duas vezes muito rápido no botão 'Aprovar'?
- [ ] **vou fazer** · fluxo: Roteamento automático de pedidos
- **Imagina assim:** Pedido 1001 está pronto pra ser aprovado. Operador clica em 'Aprovar' mas a internet está lenta. Em menos de meio segundo, clica de novo. Dois pedidos iguais tentam sair do sistema ao mesmo tempo.
- **Hoje:** O sistema bloqueia a segunda tentativa e retorna um erro. Não deixa duplicar. Mas existe uma janela bem curta onde o sistema poderia ficar confuso se duas requisições chegarem no milissegundo errado.
- **Por que importa:** Se dois cliques conseguissem passar, o pedido sairia duas vezes. Ou pior: as reservas (mercadoria apartada) seriam criadas dobradas, travando grana desnecessariamente.
- **Opções:** (A) Adicionar um cadeado digital no pedido durante a aprovação → Garante que enquanto a aprovação está acontecendo, nenhuma outra tentativa consegue mexer no pedido. Mais seguro, mas mais lento.  ·  (B) Mudar a ordem: marcar o pedido como 'em processamento' ANTES de fazer o resto → A segunda tentativa vê que o pedido já está em processamento e ignora. Mais rápido e simples.
- **Recomendação:** Usar a segunda opção. Marcar primeiro, processar depois. Previne 100% dos problemas de clique duplo e é o padrão da indústria.
- **➡️ MINHA ESCOLHA:** 
- **Código:** aprovar/route.ts:124-129

### D313 — Quando o pedido sai da filial SP pra filial RJ, quem é o dono da mercadoria no caminho?
- [ ] **vou fazer** · fluxo: Roteamento automático de pedidos
- **Imagina assim:** Pedido 3012 foi aprovado. Sistema decidiu: vai transferir do estoque em SP pra cumprir em RJ. Mercadoria sai de SP. Enquanto está no caminho (em trânsito), algo acontece: cai uma nota fiscal? Precisa de seguro? Quem responde se estragar?
- **Hoje:** O sistema registra que saiu de SP. Quando chegar em RJ, registra que entrou. Mas não deixa claro: quem é o responsável durante o trajeto? Fiscalmente, quem detém?
- **Por que importa:** Sem clareza sobre responsabilidade, fica confuso em caso de problema: se a mercadoria some no caminho, quem arca? Se há imposto a pagar, quem paga? Pode virar disputa entre filiais.
- **Opções:** (A) Filial de origem (SP) fica responsável até chegar em RJ → SP segue com a mercadoria na contabilidade até confirmação de entrada. Mais seguro fiscalmente pra SP, mas RJ fica de mãos atadas.  ·  (B) Filial de destino (RJ) assume quando sai de SP → RJ toma responsabilidade no momento que sai. Mais rápido, mas mais risco pra RJ se perder no caminho.  ·  (C) Uma empresa intermediária ou transportadora fica com a responsabilidade → Bem definido. Quem transporta, responde. Mas precisa de contrato e rastreamento claro.
- **Recomendação:** Opção 1. Filial que tem a mercadoria é responsável. Quando confirma entrada lá, passa a responsabilidade. Mais claro e padrão comercial.
- **➡️ MINHA ESCOLHA:** 
- **Código:** aprovar/route.ts:256-280

### D314 — Quando um pedido desaparece da tela porque foi encaminhado pra outro galpão, o operador deve saber disso?
- [ ] **vou fazer** · fluxo: Painel de Separação de Pedidos
- **Imagina assim:** Operador 1 (em Curitiba) está separando o pedido P1. Operador 2 (em São Paulo) encaminha P1 para Curitiba. Alguns segundos depois, Operador 1 vê P1 sumir da tela, porque o sistema filtrou: 'mostrar só pedidos de Curitiba'.
- **Hoje:** Quando o pedido é encaminhado, ele muda de galpão. O painel do Operador 1 filtra por galpão, então P1 desaparece da lista. O Operador 1 só descobre em 10 segundos (quando a tela se atualiza sozinha).
- **Por que importa:** Operador fica confuso: 'tava aqui há 5 segundos, pra onde foi?' Sem saber se foi cancelado, devolvido ou enviado, cria desconfiança no sistema.
- **Opções:** (A) Mostrar um card temporário: 'Pedido P1 foi encaminhado pra outro galpão' — depois desaparece → Operador sabe exatamente o que aconteceu. Remove a confusão.  ·  (B) Atualizar a tela em tempo real (em vez de a cada 10s) → Pedido desaparece mais rápido, mas agora o operador está 'observando' quando some.  ·  (C) Deixar visível em outra aba/filtro: 'Pedidos encaminhados pra outros galpões' → Operador pode consultar o histórico se quiser saber pra onde foi cada pedido.
- **Recomendação:** Opção 1: mostre um aviso tipo 'Pedido P1 foi encaminhado para São Paulo' por alguns segundos. Custa pouco implementar e elimina a confusão de pura.
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/app/api/wms/separacao/route.ts:158-159

### D315 — Transferência entre galpões — como evitar perder estoque no meio do caminho?
- [ ] **vou fazer** · fluxo: Entrada de estoque — como o sistema registra quando mercadoria chega
- **Imagina assim:** Operador transfere 100 unidades de SKU-123 do galpão de São Paulo (prateleira PICKING-A01) pro galpão do Rio (prateleira PICKING-B05).
- **Hoje:** Sistema registra 2 movimentos separados: sai de SP, depois entra no RJ. Se rede cair ou sistema cair ENTRE um e outro, SP fica zerado mas RJ nunca recebe. Estoque desaparece.
- **Por que importa:** Perda real de inventário. Auditoria não consegue rastrear pra onde foi. Pode perder milhares de reais em mercadoria.
- **Opções:** (A) Exigir que tudo aconteça em 1 tudo-ou-nada → Se falhar no meio, NADA acontece. SP continua com 100, RJ não recebe. Seguro, mas operador precisa tentar de novo.  ·  (B) Criar tarefa que roda sozinha em segundo plano e varre transferências incompletas e completa → Sistema detecta transferências 'penduradas' e termina sozinho. Melhor experiência, mais complexo.
- **Recomendação:** Opção A agora (seguro) + Opção B como backup (proteção extra pra pegar qualquer caso que caiu no meio).
- **➡️ MINHA ESCOLHA:** 
- **Código:** src/lib/wms/movimentacoes.ts:302-340

### D316 — Quando um galpão novo vira preferencial da empresa, os pedidos que estão esperando aprovação devem ser re-roteados automaticamente?
- [ ] **vou fazer** · fluxo: Controle de Empresas, Filiais e Galpões
- **Imagina assim:** NetAir2 não tinha galpão preferencial (vazio). Um administrador marca CWB como novo preferencial. NetAir2 tem um pedido esperando aprovação. Pergunta: esse pedido deve tentar CWB agora, ou mantém o roteamento que tinha antes?
- **Hoje:** O sistema deixa os pedidos que já estão na fila continuar com a rota que tinham. Só novos pedidos (que chegam depois) usam o preferencial novo.
- **Por que importa:** Se a NetAir ficou sem galpão durante muito tempo e agora ganhou um novo, talvez tenha vários pedidos esperando. Se esses pedidos ignorarem o novo preferencial, podem ir pra galpão errado ou ficar presos. Ou ao contrário: podem ser imediatamente re-roteados e mudar de galpão no meio do caminho, causando bagunça.
- **Opções:** (A) Pedidos que já estão na fila ignorem o novo preferencial — mantêm a rota anterior → Simples, não causa bagunça. Mas se a rota anterior está longe ou sem estoque, o pedido fica preso.  ·  (B) Pedidos na fila são re-roteados imediatamente (tentam o novo preferencial primeiro) → Aproveita o novo galpão. Mas pode causar bagunça se o pedido já começou a processar com a rota antiga.  ·  (C) Só pedidos que ainda estão em 'validação' (esperando aprovação) são re-roteados; pedidos já em separação mantêm rota antiga → Meio-termo: aproveita o novo preferencial para os que ainda estão esperando, sem mexer nos que já começaram.
- **Recomendação:** Re-rotear apenas pedidos que ainda estão em validação (esperando aprovação). Pedidos que já começaram a separação mantêm a rota que tinham.
- **➡️ MINHA ESCOLHA:** 
- **Código:** empresas/[id]/route.ts:50-79

