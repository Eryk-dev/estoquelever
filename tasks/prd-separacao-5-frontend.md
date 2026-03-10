# PRD 5/7 — Separação: Frontend (Tela de Separação)

**Depende de:** PRD 4 (API Separação)
**Bloqueia:** PRD 7 (Etiqueta — precisa do frontend para UX completa)

---

## 1. Introdução

Este PRD implementa a página `/separacao` — a tela principal onde operadores de galpão veem pedidos pendentes, bipam itens via scanner/teclado, e acompanham o progresso da separação com feedback visual e sonoro.

### Problema que resolve

- Operadores usam o módulo de separação do Tiny, que mostra localização errada para transferências
- Operador precisa alternar entre contas Tiny para ver pedidos de diferentes empresas
- Não há visão unificada de todos os pedidos que precisam ser separados num galpão

---

## 2. Goals

- Tela única por galpão com todos os pedidos para separar
- Campo de scan com auto-focus para leitor de código de barras
- Feedback sonoro imediato (sucesso, erro, completo)
- 4 tabs com contadores: Aguardando NF | Pendentes | Embalados | Expedidos
- Localização correta por galpão do operador
- Undo de bip com toast temporário

---

## 3. User Stories

### US-001: Tela de separação por galpão

**Description:** Como operador de galpão, quero ver todos os pedidos pendentes de separação no meu galpão, para separar fisicamente os itens sem trocar de conta Tiny.

**Acceptance Criteria:**
- [ ] Nova página `/separacao` acessível via nav (ou URL direta)
- [ ] Lista filtra automaticamente pelo galpão do operador logado (cargo `operador_cwb` → CWB, `operador_sp` → SP, `admin` → todos com seletor)
- [ ] Aba "Pendentes" mostra pedidos com `status_separacao = 'pendente'` ou `'em_separacao'`
- [ ] Cada pedido exibe: número, cliente, ecommerce, forma de envio, decisão (própria/transferência), quantidade de itens, progresso de bips
- [ ] Pedidos ordenados por data (mais antigo primeiro)
- [ ] Contagem de pedidos por aba visível
- [ ] TanStack Query com `refetchInterval: 10000` (10s) para atualizar automaticamente
- [ ] Typecheck/lint passes

---

### US-002: Localização correta por galpão

**Description:** Como operador, quero ver a localização do produto no MEU galpão (não a do galpão de origem da venda), para encontrar o item no depósito correto.

**Acceptance Criteria:**
- [ ] Cada item exibe localização vinda da API (já resolvida no PRD 4 por galpão do operador)
- [ ] Quando localização é `null`, exibe "Sem localização" com destaque visual (text muted + ícone)
- [ ] Localização exibida com destaque (badge ou texto bold) para fácil leitura à distância
- [ ] Typecheck/lint passes

---

### US-003: Scan de itens por SKU/GTIN (Frontend)

**Description:** Como operador, quero bipar o código de barras ou digitar o SKU no campo de scan.

**Acceptance Criteria:**
- [ ] Campo de scan no topo da tela (auto-focus ao carregar página)
- [ ] Aceita GTIN (EAN-13, leitura por scanner) ou SKU (digitação manual)
- [ ] Ao submeter (Enter ou scan completo), chama `POST /api/separacao/bipar`
- [ ] Item bipado recebe visual de "conferido" (check verde, row highlighted)
- [ ] Se SKU/GTIN não encontrado (404), feedback sonoro de erro + toast de erro
- [ ] Se item já completado (409), feedback sonoro distinto + toast de aviso
- [ ] Para itens com quantidade > 1, exibe progresso "2/3 bipados"
- [ ] Campo limpa automaticamente após processar (ready para próximo scan)
- [ ] Feedback sonoro via Web Audio API:
  - Sucesso (item encontrado): bip curto agudo
  - Erro (não encontrado): tom grave duplo
  - Completo (pedido finalizado): melodia ascendente
  - Já bipado (409): tom médio único
  - AudioContext inicializado no primeiro scan (requer interação do usuário)
- [ ] Pedido que completou todos os bips move automaticamente para aba "Embalados"
- [ ] Typecheck/lint passes

---

### US-012: Aba "Embalados" na tela de separação

**Description:** Como operador, quero ver os pedidos já embalados com opção de reimprimir etiqueta.

**Acceptance Criteria:**
- [ ] Tab "Embalados" lista pedidos com `status_separacao = 'embalado'`
- [ ] Cada pedido mostra: número, hora que embalou, quem embalou, `etiqueta_status`
- [ ] Pedidos com `etiqueta_status = 'falhou'` exibem badge visual vermelho
- [ ] Botão "Reimprimir Etiqueta" (funcionalidade real no PRD 7 — aqui mostra botão disabled com tooltip "Impressão será configurada em breve" até PRD 7)
- [ ] Botão "Marcar como Expedido" (individual) move para status `expedido`
- [ ] Botão "Expedir Selecionados" (batch) — checkboxes + ação em lote
- [ ] Typecheck/lint passes

---

### US-014: Aba "Aguardando NF" na tela de separação

**Description:** Como operador, quero ver os pedidos que já foram aprovados mas ainda aguardam NF autorizada.

**Acceptance Criteria:**
- [ ] Tab "Aguardando NF" lista pedidos com `status_separacao = 'aguardando_nf'`
- [ ] Cada pedido mostra: número, cliente, ecommerce, decisão, quantidade de itens
- [ ] Pedidos com mais de 2h em `aguardando_nf` exibem badge "Atenção" (cor warning)
- [ ] Pedidos são somente-leitura (sem ação de bip ou impressão)
- [ ] Admin vê botão "Forçar Pendente" que chama `PATCH /api/separacao/{pedidoId}/forcar-pendente`
- [ ] Contagem visível na tab
- [ ] Typecheck/lint passes

---

### US-015: Desfazer bip (undo) (Frontend)

**Description:** Como operador, quero desfazer um bip errado com botão temporário no toast.

**Acceptance Criteria:**
- [ ] Após cada bip bem-sucedido, toast exibe "Bip registrado — SKU123 (2/3)" com botão "Desfazer" ativo por 10 segundos
- [ ] Clicando "Desfazer": chama `POST /api/separacao/desfazer-bip`
- [ ] Toast de confirmação: "Bip desfeito"
- [ ] UI atualiza imediatamente (optimistic update + revalidação)
- [ ] Após 10 segundos, botão "Desfazer" desaparece — correção posterior via seleção manual do pedido
- [ ] Typecheck/lint passes

---

## 4. Functional Requirements

- FR-1: Página `/separacao` como `"use client"` com TanStack Query
- FR-2: Auto-filtro por galpão do operador (derivado do cargo no auth context)
- FR-3: Campo de scan com auto-focus, submit on Enter, auto-clear
- FR-4: 4 tabs com pill-style (reusar componente `Tabs` existente): Aguardando NF | Pendentes | Embalados | Expedidos
- FR-5: Contadores por tab atualizados em tempo real
- FR-6: Feedback sonoro via Web Audio API (4 sons distintos)
- FR-7: Toast com undo (10s timeout) usando Sonner
- FR-8: Pedidos OC com badge "Aguardando Estoque" e bip desabilitado (campo de scan não processa itens de OC)
- FR-9: Admin com seletor de galpão (dropdown) quando `galpaoId = null`
- FR-10: Mobile-friendly (max-w-3xl, responsive)
- FR-11: Polling com `refetchInterval: 10000` para todas as tabs

---

## 5. Non-Goals

- **Não** implementar impressão real de etiqueta (PRD 7 — botões ficam placeholder)
- **Não** implementar realtime via Supabase subscriptions (polling é suficiente para ~500 pedidos/dia)
- **Não** implementar picking list agrupada por produto

---

## 6. Technical Considerations

### 6.1 Estrutura de Componentes

```
src/app/separacao/
  page.tsx                          # Página principal com tabs e scan

src/components/separacao/
  scan-input.tsx                    # Campo de scan com auto-focus e audio feedback
  pedido-separacao-card.tsx         # Card de pedido na separação (com itens e progresso)
  item-separacao-row.tsx            # Row de item com localização e status de bip
  audio-feedback.ts                 # Web Audio API helper (4 sons)
  tab-aguardando-nf.tsx             # Conteúdo da aba Aguardando NF
  tab-pendentes.tsx                 # Conteúdo da aba Pendentes
  tab-embalados.tsx                 # Conteúdo da aba Embalados
  tab-expedidos.tsx                 # Conteúdo da aba Expedidos
```

### 6.2 Audio Feedback (Web Audio API)

```typescript
// audio-feedback.ts
// Criar AudioContext no primeiro scan (user interaction required)
// 4 funções: playSuccess(), playError(), playComplete(), playAlreadyDone()
// Cada uma gera tom via OscillatorNode (sem arquivos de áudio)
// Success: 880Hz, 100ms
// Error: 220Hz, 200ms x2
// Complete: 440→880→1320Hz, 150ms each
// Already done: 440Hz, 200ms
```

### 6.3 Scan Flow (Frontend)

```
1. Operador bipa → input captura string
2. Submit (Enter) → POST /api/separacao/bipar { codigo }
3. Response:
   - parcial/item_completo → playSuccess(), toast com undo, highlight item
   - pedido_completo → playComplete(), toast "Pedido #X embalado!", refetch
   - 404 → playError(), toast error
   - 409 → playAlreadyDone(), toast warning
4. Clear input, re-focus
```

### 6.4 Estado do Pedido Card

Cada card de pedido na aba "Pendentes" mostra:
- Header: `#8832 | João Silva | Mercado Livre | Sedex | Própria`
- Progress bar: `3/5 itens bipados`
- Lista de itens:
  - `✓ SKU123 — Filtro de óleo — Loc: A-03-02 — 1/1` (verde, bipado)
  - `○ SKU456 — Pastilha freio — Loc: B-01-05 — 0/2` (pendente)
  - `○ SKU789 — Correia dentada — Sem localização — 0/1` (pendente, loc muted)

### 6.5 Sessionld no Fetch

O auth-context (atualizado no PRD 2) fornece `sessionId`. Criar wrapper:
```typescript
async function fetchSeparacao(url: string, options?: RequestInit) {
  const sessionId = getSessionId(); // from localStorage
  return fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      'X-Session-Id': sessionId,
      'Content-Type': 'application/json',
    },
  });
}
```

---

## 7. Validação

1. Logar como operador_cwb → ver apenas pedidos do galpão CWB
2. Bipar item → ver feedback visual + sonoro + toast com undo
3. Bipar item inexistente → ver erro + som de erro
4. Completar todos os itens de um pedido → ver pedido mover para "Embalados"
5. Clicar "Desfazer" no toast → bip revertido
6. Admin → ver seletor de galpão
7. Pedido em "Aguardando NF" por > 2h → badge "Atenção"

---

## 8. Success Metrics

- Operador consegue bipar pedido completo sem tirar os olhos do scanner (auto-focus + auto-clear)
- Feedback sonoro distinguível em ambiente de galpão (sons distintos)
- Tabs atualizam a cada 10s sem refresh manual
- Zero cliques necessários entre bips (campo auto-limpa e re-foca)
