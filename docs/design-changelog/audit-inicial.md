# Audit Inicial de Design - SISO Estoque Lever

Data: 2026-04-02

## Problemas Globais (afetam todas as telas)

### 1. Identidade Visual Fraca
- Sem design system definido (sem tokens de cor, spacing, tipografia consistentes)
- Botao primario hora e cinza, hora e dark, sem cor de marca
- Logo SISO sem tratamento consistente

### 2. Tipografia Inconsistente
- Sem escala tipografica clara (heading vs body vs caption)
- Tamanhos de texto variam sem padrao
- Peso de fontes inconsistente entre paginas

### 3. Empty States Pobres
- Inventario, Transferencia: apenas texto cinza "Nenhum X em andamento"
- Sem ilustracao, sem CTA claro, sem orientacao ao usuario

### 4. Espacamento Inconsistente
- Padding interno de cards varia entre paginas
- Gap entre elementos sem padrao
- Margens laterais inconsistentes

### 5. Status/Badges sem Sistema
- Cores de status mudam entre modulos (OC, decisao, etapas)
- Badges com formas e tamanhos diferentes
- Sem legenda ou padrao claro

### 6. Botoes sem Hierarquia
- Primario, secundario e ghost sem distincao clara
- "Entrar" no login e cinza (deveria ser marca)
- "Gerar Preview" em Etiquetas e cinza
- "Aprovar" e dark/filled (OK) mas "Ordem de Compra" e text-only

---

## Audit por Tela

### 1. Login (2:2)
**Estado:** Funcional mas generico
**Problemas:**
- Botao "Entrar" cinza sem vida — deveria ser cor primaria
- Campo PIN mostra "0 0 0 0" — confuso, deveria ser placeholder tipo "****"
- Sem background visual (gradiente, pattern, ou imagem)
- Subtitulo "Separacao de Ordens" em roxo claro — pouco contraste
- Form container com borda muito sutil — quase invisivel
- Icone de cadeado muito pequeno

**Melhorias:**
- [ ] Botao primario com cor de marca (dark navy ou accent)
- [ ] Background com gradiente sutil ou pattern
- [ ] Melhorar contraste do subtitulo
- [ ] PIN input com dots/asteriscos ao inves de numeros
- [ ] Card do form com sombra leve + borda mais visivel

---

### 2. SISO Dashboard (7:2)
**Estado:** Bom — melhor tela do app atualmente
**Problemas:**
- Cards de pedido sao densos mas bem estruturados
- Barra lateral colorida (left border) e um bom pattern — manter
- Badge "OC" laranja bom, "Transferencia CWB" bom
- Search bar poderia ter icone mais visivel
- Tabs com estilo pill — funcionam bem

**Melhorias:**
- [ ] Refinar typography nos cards (hierarchia de informacao)
- [ ] Hover state nos cards
- [ ] Melhorar icones de acao (copiar, menu)
- [ ] Ajustar spacing entre cards

---

### 3. Home Dashboard (16:2)
**Estado:** Muito basico
**Problemas:**
- Cards de modulo sem presenca visual — muito flat
- Icones coloridos sao bons mas os cards nao tem personalidade
- Grid 2x3 com ultimo card sozinho — desbalanceado
- Muito espaco vazio
- Subtitulo "Todos os galpoes" pouco visivel

**Melhorias:**
- [ ] Cards com hover effect (elevacao, cor de fundo sutil)
- [ ] Adicionar contadores em cada card (ex: "12 pendentes")
- [ ] Melhorar grid — considerar layout diferente para 5 itens
- [ ] Background gradient sutil na area do header
- [ ] Cards com borda lateral colorida (match cor do icone)

---

### 4. Pedidos (18:2)
**Estado:** Funcional mas muito denso
**Problemas:**
- Tabela com rows muito apertadas — dificil scanear
- Status badges coloridos (verde, laranja, rosa) — bom uso de cor
- Coluna de acoes (CWB/SP) com icones muito pequenos
- Tabs "Pedidos" e "Expedidos" — basicas
- Search bar funcional

**Melhorias:**
- [ ] Aumentar row height (44px → 52px minimo)
- [ ] Alternating row colors (zebra) ou hover highlight
- [ ] Status badges com texto mais legivel
- [ ] Header da tabela com background distinto
- [ ] Paginacao com mais destaque

---

### 5. Compras (19:2)
**Estado:** Bom design de cards
**Problemas:**
- Cards de fornecedor sao limpos e informativos
- Alerta "2 itens com excecao" amarelo — bom
- Badge "ha 11d" vermelho mostra urgencia — bom
- Card "141" com borda azul/teal — nao segue o padrao dos outros
- Tabs "Comprar/Aguardando/Recebidos" — OK

**Melhorias:**
- [ ] Padronizar bordas dos cards (remover borda especial do 141)
- [ ] Adicionar indicador visual de prioridade mais claro
- [ ] Expandir preview de itens dentro do card
- [ ] KPI bar no topo (total bloqueados, valor estimado, etc)

---

### 6. Inventario (20:2)
**Estado:** Quase vazio
**Problemas:**
- Empty state e apenas texto cinza — sem vida
- Botao "+ Novo" isolado no canto — pouco convidativo
- Muito espaco desperdicado

**Melhorias:**
- [ ] Empty state com ilustracao (barcode scanner icon grande)
- [ ] CTA centralizado "Iniciar novo inventario"
- [ ] Dica contextual sobre o que e inventario
- [ ] Quando tiver dados: cards com progresso visual

---

### 7. Transferencias (21:2)
**Estado:** Identico ao Inventario — mesmo problema
**Problemas:** Mesmos do Inventario
**Melhorias:**
- [ ] Empty state com ilustracao (truck/transfer icon)
- [ ] CTA centralizado "Iniciar nova transferencia"
- [ ] Dica contextual

---

### 8. Etiquetas (22:2)
**Estado:** Formulario basico
**Problemas:**
- Botao "Gerar Preview" cinza — deveria ser primario
- Inputs sem estilo marcante
- Layout poderia mostrar preview ao lado
- Labels "Corredor/Horizontal/Vertical" — claras

**Melhorias:**
- [ ] Botao primario com cor de marca
- [ ] Preview visual da etiqueta ao lado do form
- [ ] Inputs com melhor focus state
- [ ] Explicacao visual de como Corredor/H/V mapeiam pro galpao

---

### 9. Configuracoes (23:2)
**Estado:** Bem estruturado
**Problemas:**
- Secoes bem separadas (Webhook, Galpoes, Grupos, PrintNode)
- Cards de shortcut (Usuarios, Monitoramento) no topo — bom
- Info banner azul — bom pattern
- Hierarquia Galpao > Empresa bem representada
- Botao "Testar Conexao" com estilo diferente dos outros

**Melhorias:**
- [ ] Padronizar botoes
- [ ] Separadores de secao mais claros
- [ ] Accordion para Galpoes com muitas empresas
- [ ] Status indicators mais visiveis (Conectado/Inativa)

---

### 10. Admin Usuarios (24:2)
**Estado:** Limpo e funcional
**Problemas:**
- Cards de usuario sao claros
- Badges de cargo coloridos — bom (laranja=Operador, roxo=Comprador, dark=Admin)
- Galpao badges (SP, CWB) com estilo diferente — OK
- Botoes "Desativar" e lixeira consistentes

**Melhorias:**
- [ ] Avatar placeholder ou iniciais do usuario
- [ ] Separador visual entre active/inactive users
- [ ] Confirmar que cores de cargo sao consistentes com o resto do app

---

### 11. Painel Operacao (31:2)
**Estado:** Excelente — melhor tela junto com Gerencial
**Problemas:**
- KPI cards com icones e cores — muito bom
- Funil operacional claro com progress bars
- Janela de SLA com cores de urgencia (vermelho=vencido) — excelente
- Carga por operador — bom
- Alerta "1044 pedidos com prazo vencido" vermelho — efetivo
- Ritmo do dia com grafico — bom

**Melhorias:**
- [ ] Refinar alinhamento de numeros nas KPI cards
- [ ] Progress bars com labels mais legiveis
- [ ] Grafico de ritmo com tooltips
- [ ] Secao "Filas envelhecidas" com melhor hierarquia visual

---

### 12. Painel Gerencial (32:2)
**Estado:** Excelente
**Problemas:**
- KPI cards com comparativo temporal — muito bom
- Lead time com P90 — informacao avancada, bem apresentada
- Mix por decisao e canal — bom uso de barras horizontais
- Disciplina operacional — metricas de qualidade

**Melhorias:**
- [ ] Grafico de produtividade 7d com labels melhores
- [ ] Erros da integracao com severity indicators
- [ ] Melhorar legibilidade de percentuais

---

### 13. Separacao - Pendentes (45:2)
**Estado:** Funcional, principal tela de operacao
**Problemas:**
- Header com resumo (Etapa Atual, Selecionados, Prontos) — excelente
- Cards de pedido com muita informacao — densos mas necessarios
- Badges de status (Pronto para separar, OC Pendente) — bom
- Icones de acao (bipar, copiar, menu) — funcionais
- Validacao OC expandida dentro do card — bom

**Melhorias:**
- [ ] Skeleton loading placeholders (ja tem, manter)
- [ ] Cards com hover mais evidente
- [ ] Melhorar area de bulk actions (Mover, Separar)
- [ ] Tags filtro com cores mais distintas

---

### 14. Separacao - Aguardando OC (46:2)
**Estado:** Muito longo (7924px) — muitos pedidos
**Problemas:**
- Cards com highlight amarelo (OC pendente) e azul (aguardando) — bom
- Cards expandidos com tabela de itens OC — funcional
- Muita repeticao visual — fadiga

**Melhorias:**
- [ ] Agrupar por fornecedor (como Compras faz)
- [ ] Collapse/expand para reduzir altura
- [ ] Indicador de scroll ou paginacao

---

### 15. Separacao - Pick OC (47:2)
**Estado:** Checklist detalhado
**Problemas:**
- Secao "Conferencia OC" em destaque (amarelo) — bom
- Itens com OC/decisao clara
- Status "Esgotado" em vermelho — bom
- Localizacao do item (ex: "B-02-3") — util

**Melhorias:**
- [ ] Checkbox maior para touch (mobile)
- [ ] Indicador de progresso mais visivel (0 de 7)
- [ ] Melhorar contraste de SKU codes

---

### 16. Separacao - Embalagem OC (48:2)
**Estado:** Lista simples
**Problemas:**
- Cards de pedido compactos — funcional
- "Pendentes (32)" com contagem — bom
- Progresso "0/1" por pedido — basico
- Scan input no topo

**Melhorias:**
- [ ] Progress visual (barra) ao inves de "0/1"
- [ ] Indicador de qual pedido e OC vs normal
- [ ] Melhorar hierarquia visual

---

### 17. Separacao - Checklist (50:2)
**Estado:** Principal tela de wave picking — muito importante
**Problemas:**
- Lista de itens com checkbox, SKU, descricao, qty — completa
- Badge "OC" em vermelho, qty "2x" — bom
- Localizacao com edit icon — bom
- Status "Esgotado" com indicador vermelho — bom
- Progress bar no topo "0 de 30" — funcional
- Botoes de acao no bottom bar (Concluir, Reiniciar, Cancelar)

**Melhorias:**
- [ ] Items bipados com visual de "done" mais forte (strikethrough + green bg)
- [ ] Separar itens OC vs normais visualmente
- [ ] Highlight do proximo item a bipar
- [ ] Sound feedback indicator visual

---

### 18. Separacao - Embalagem (51:2)
**Estado:** Lista longa de pedidos para embalar
**Problemas:**
- Cards compactos com info essencial
- Progresso "0/1" por pedido
- Items inseridos (produto destaque) — padrao diferente
- Acao "+" para adicionar item

**Melhorias:**
- [ ] Cards com status visual mais claro
- [ ] Agrupar por empresa (NetAir vs NetParts)
- [ ] Progress bar visual

---

### 19. Separacao - Separados (53:2)
**Estado:** Mesma estrutura de Pendentes mas com tab Separados
**Problemas:**
- Empty state "Carregando pedidos..." — placeholder
- Header com resumo OK
- Mesmos patterns dos outros tabs de separacao

**Melhorias:**
- [ ] Empty state correto quando nao ha pedidos
- [ ] Manter consistencia com outros tabs

---

## Prioridade de Implementacao

### Alta (impacto visual imediato)
1. **Login** — primeira impressao
2. **Home Dashboard** — hub principal
3. **Empty States** (Inventario, Transferencia) — profissionalismo
4. **Separacao - Checklist** — tela mais usada operacionalmente

### Media (polish)
5. SISO Dashboard refinements
6. Compras card improvements
7. Pedidos table improvements
8. Configuracoes consistency

### Baixa (ja estao bons)
9. Painel Operacao (ja excelente)
10. Painel Gerencial (ja excelente)
11. Admin Usuarios (ja funcional)
