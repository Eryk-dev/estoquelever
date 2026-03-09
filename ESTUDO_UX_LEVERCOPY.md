# Estudo de UX - Levercopy → SISO
## Padroes de Usabilidade Extraidos para Replicar

---

## 1. FILOSOFIA DE DESIGN

O Levercopy segue o principio **"olhar, decidir, proximo"** — toda informacao necessaria esta visivel no card, feedback e imediato, e o operador nunca precisa navegar para outra tela para tomar uma decisao.

**Principios:**
- Informacao densa mas organizada (nada escondido atras de cliques)
- Sugestao pre-selecionada (sistema decide, operador confirma ou corrige)
- Feedback visual instantaneo para cada acao
- Zero fricao entre ver e agir

---

## 2. DESIGN TOKENS

O Levercopy usa CSS custom properties como sistema de design. No SISO, traduzir para Tailwind theme.

### Cores
```
Texto:     --ink (primario), --ink-muted (secundario), --ink-faint (terciario)
Fundos:    --paper (formularios), --surface (cards), --line (bordas)
Status:    --success (#10b981), --danger (#ef4444), --warning (#f59e0b)
Semantico: --positive (#23D8D3), --attention (#d97706), --info (#3b82f6)
```

### Espacamento
```
Base 4px: --space-1 (4px) ate --space-12 (48px)
Padding de inputs: --space-3 (12px) horizontal, --space-4 (16px) vertical
Border radius: 6px padrao
```

### Tipografia
```
Sans: Inter
Mono: SF Mono / Fira Code
Tamanhos: --text-xs (11px), --text-sm (13px), --text-base (15px), --text-lg (18px), --text-xl (22px), --text-2xl (28px)
```

### Dark Mode
- Ativado automaticamente via `@media (prefers-color-scheme: dark)`
- Troca toda a paleta de cores (ink, paper, surface, line)
- Sem toggle manual — respeita preferencia do sistema
- Logo inverte com `filter: invert(1)` no dark mode

---

## 3. NAVEGACAO

### Tabs com Contadores
- Navegacao principal por tabs horizontais com badge numerico
- Exemplo: `Pendente (12)` | `Concluidos (138)` | `Auto (350)`
- Tab ativa: fundo preenchido (cor primaria)
- Tab inativa: fundo transparente, texto sutil
- Visibilidade condicional por role (operador nao ve tab admin)

### Fluxo de Navegacao
- Login → App com tabs (sem sidebar, sem breadcrumbs)
- Troca de view e instantanea (state, sem rota)
- Nenhuma navegacao profunda — tudo acessivel em 1 clique

**Aplicacao no SISO:** As 3 abas do escopo (Pendente, Concluidos, Auto) seguem exatamente esse padrao. Badge com contagem em tempo real via Supabase Realtime.

---

## 4. FEEDBACK VISUAL

### 4.1 Toast Notifications
- Posicao: bottom-center, z-index 9999
- Auto-dismiss: 2.2 segundos
- Animacao entrada: scale + translate (toastIn)
- Animacao saida: slide down + fade out (toastOut, 220ms)
- Dois tipos: success (icone check, borda verde) e error (icone exclamacao, borda vermelha)
- Pointer-events desabilitados durante animacao de saida

**Aplicacao no SISO:** Usar shadcn/Sonner com mesma UX. Toast ao aprovar pedido ("Pedido #90892 aprovado"), ao ocorrer erro ("Outro operador ja aprovou este pedido").

### 4.2 Shake Animation (Erro de Validacao)
```css
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-8px); }
  40%, 80% { transform: translateX(8px); }
}
/* Duracao: 500ms */
```
- Aplicado ao formulario/card inteiro quando validacao falha
- Erro textual aparece abaixo do campo

**Aplicacao no SISO:** Shake no card do pedido se tentar aprovar e falhar (lock otimista).

### 4.3 Spinner no Botao
- Ao clicar em acao, botao mostra spinner (16px, border-top rotation)
- Texto do botao muda (ex: "Aprovar" → "Aprovando...")
- Botao fica `disabled` com `opacity: 0.3`
- Previne duplo-click

**Aplicacao no SISO:** Botao "Aprovar →" mostra spinner + "Aprovando..." enquanto chama API.

### 4.4 Status Badges
- Cor por estado: success (verde), error (vermelho), partial (laranja), in_progress (azul)
- `in_progress` tem animacao pulse (opacity + scale pulsando)
```css
@keyframes pulse-badge {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.95); }
}
```
- Texto uppercase, font-size pequeno, padding compacto

**Aplicacao no SISO:** Badge "Executando" com pulse nos pedidos sendo processados pelo worker. Badges "Auto", "CWB", "SP", "OC" na aba Concluidos.

### 4.5 Card Desaparecendo
- Ao completar acao, card some com animacao (fadeOut + slideUp)
- Em tempo real: se outro operador aprova, card some via Realtime

**Aplicacao no SISO:** Card do pedido some com animacao ao aprovar. Supabase Realtime remove cards aprovados por outros operadores.

---

## 5. FORMULARIOS

### Validacao
- Erro limpa automaticamente ao usuario digitar (onChange limpa estado de erro)
- Validacao campo-a-campo (nao espera submit para mostrar erro)
- Shake animation no form inteiro quando submit falha
- Mensagem de erro centralizada abaixo do campo, cor --danger

### Inputs
- Padding consistente: 12px vertical, 16px horizontal
- Borda: cor --line normal, cor --danger quando erro
- Border-radius: 6px
- Focus: outline escuro + box-shadow

### Submit
- Botao desabilitado ate formulario valido
- Spinner + texto alterado durante request
- Toast de confirmacao no sucesso
- Form reseta apos criacao bem-sucedida

### Atalhos de Teclado
- **Enter**: submete formulario
- **Escape**: fecha formulario inline, cancela edicao

**Aplicacao no SISO:** O pedido ja vem com radio pre-selecionado (sugestao). Operador so precisa confirmar com "Aprovar". Se mudar de ideia, seleciona outro radio e confirma. Sem formulario complexo.

---

## 6. LISTAS E CARDS

### Layout Card-based
- Cada item e um card independente com todas as informacoes
- Header do card: dados resumidos (numero, cliente, data, plataforma)
- Corpo do card: tabela de itens com dados comparativos
- Footer do card: opcoes de acao (radio buttons) + botao de acao
- Informacao contextual abaixo de cada opcao (consequencia da escolha)

### Filtros por Status
- Tabs de filtro com contadores: "Todos (24)", "Sucesso (18)", "Erros (3)"
- Filtro ativo muda instantaneamente (client-side quando possivel)

### Detalhes Expandiveis
- Clique no card expande detalhes adicionais
- Indicador chevron (seta para baixo/cima)
- Transicao suave de altura

### Ordenacao
- Mais antigo primeiro (FIFO) na fila de pendentes
- Mais recente primeiro no historico

### Paginacao
- Load-more (botao "Carregar mais" no final da lista)
- Sem paginacao numerada

**Aplicacao no SISO:** Cards de pedido ja seguem esse padrao no escopo. Tabela de itens com estoque CWB/SP dentro de cada card. Radio pre-selecionado + botao "Aprovar →".

---

## 7. ESTADOS ESPECIAIS

### Loading
- Spinner centralizado enquanto dados carregam
- Texto "Carregando..." abaixo do spinner
- Condicional: loading → empty state → lista

### Empty State
- Mensagem simples e direta: "Nenhum pedido pendente"
- Sem ilustracoes complexas, apenas texto centralizado com cor --ink-muted
- Serve como confirmacao positiva (fila vazia = tudo processado)

### Erro de Concorrencia
- Quando outro operador ja aprovou: card some + toast de aviso
- Mensagem clara: "Este pedido ja foi aprovado por outro operador"

**Aplicacao no SISO:** Empty state na fila = "Todos os pedidos foram processados". Erro de lock otimista = toast + card some.

---

## 8. TEMPO REAL

### Polling
- Polling de 5 segundos quando ha operacoes em andamento
- Para automaticamente quando nao ha operacoes ativas
- Complementa WebSocket/Realtime como fallback

### Visibility Change
- Auto-refresh quando tab do navegador fica visivel novamente
- `document.addEventListener('visibilitychange', ...)`
- Garante dados atualizados quando operador volta para a aba

**Aplicacao no SISO:** Supabase Realtime como primario + TanStack Query refetch periodico como fallback (ja previsto no escopo). Visibility change para re-sync quando operador volta.

---

## 9. BOTOES

### Variantes
```
btn-primary:      Fundo escuro, texto branco, hover opacity reduz, active scale(0.97), disabled opacity 0.3
btn-ghost:        Fundo transparente, borda visivel, hover fundo sutil, active scale(0.97)
btn-danger-ghost: Fundo transparente, borda+texto vermelho, hover fundo vermelho translucido
```

### Comportamento
- Transicao de opacity: 0.2s
- Scale no active: `transform: scale(0.97)` — feedback tatil
- Disabled: opacity 0.3, cursor not-allowed, pointer-events none

**Aplicacao no SISO:** Botao "Aprovar →" = btn-primary. Botao "Re-tentar" em pedidos com erro = btn-ghost. Acoes destrutivas = btn-danger-ghost.

---

## 10. ANIMACOES

```css
/* Entrada de elementos */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
/* Duracao: 0.25s */

/* Cards aparecendo */
@keyframes slideUp {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
/* Duracao: 0.3s */

/* Spinner de loading */
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Badge de status ativo */
@keyframes pulse-badge {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.6; transform: scale(0.95); }
}

/* Erro de validacao */
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-8px); }
  40%, 80% { transform: translateX(8px); }
}
/* Duracao: 500ms */
```

**Aplicacao no SISO:** Todas essas animacoes se aplicam. No Tailwind, usar `animate-*` custom ou classes utilitarias.

---

## 11. PADROES CRUD

| Operacao | Padrao Levercopy | Aplicacao SISO |
|----------|-----------------|----------------|
| Create | Botao revela form, grid layout, spinner submit, toast, reset | N/A (pedidos vem via webhook) |
| Read | Fetch no mount, spinner, empty state, lista condicional | Fila carrega via TanStack Query |
| Update | Inline edit (editingId), save/cancel, campos opcionais | Radio select + Aprovar (inline no card) |
| Delete | confirm() nativo, spinner, toast, re-fetch | N/A (pedidos nao sao deletados) |

---

## 12. PERMISSOES NA UI

- Componentes/tabs ocultos baseado no role do usuario
- Operador ve apenas sua fila (filtrada por filial)
- Admin ve todas as filas + configuracoes
- Dropdowns filtrados por permissao do usuario
- Botoes de acao aparecem apenas para quem tem permissao

**Aplicacao no SISO:** Operador CWB ve fila CWB. Operador SP ve fila SP. Admin ve ambas + metricas + config.

---

## 13. RESPONSIVIDADE

Breakpoints do Levercopy:
- `> 900px`: layout completo, grid multi-coluna
- `760px - 900px`: header flexiona, grid 1 coluna
- `< 640px`: toast full-width, cards ocupam tela toda

**Aplicacao no SISO:** Desktop-first (operadores usam PC). Mesmo assim, manter responsividade basica para consultas eventuais em mobile.

---

## 14. RESUMO: CHECKLIST DE UX PARA O SISO

- [ ] Design tokens no Tailwind theme (cores, espacamento, tipografia)
- [ ] Dark mode automatico (prefers-color-scheme)
- [ ] Tabs com badge de contagem (Pendente, Concluidos, Auto)
- [ ] Cards de pedido com info densa e organizada
- [ ] Radio pre-selecionado com sugestao do sistema
- [ ] Info contextual abaixo de cada opcao do radio
- [ ] Botao "Aprovar" com spinner + disabled durante request
- [ ] Toast success/error com auto-dismiss 2.2s
- [ ] Shake animation em erro de validacao/concorrencia
- [ ] Status badges coloridos com pulse para "executando"
- [ ] Card some com animacao ao aprovar
- [ ] Realtime: cards somem quando outro operador aprova
- [ ] Polling fallback 5s + visibility change refresh
- [ ] Empty state: "Todos os pedidos foram processados"
- [ ] Loading state: spinner centralizado
- [ ] Escape fecha modais, Enter confirma
- [ ] Botoes com scale(0.97) no active
- [ ] Confirmacao para acoes criticas (confirm nativo)
- [ ] Permissoes filtram UI por role/filial
- [ ] Animacoes: fadeIn, slideUp, spin, pulse, shake
