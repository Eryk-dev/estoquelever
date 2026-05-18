# 001 - Brand Identity Lever Talents

Data: 2026-04-02

## Contexto

O app SISO tinha visual generico de AI — tudo flat, cinza zinc, sem personalidade, sem identidade de marca. A Lever Talents tem uma identidade visual definida (PDF em `marca/IDENTIDADE VISUAL - LEVER TALENTS - comp.pdf`) que nao estava sendo aplicada.

## Identidade Visual Lever Talents

### Personalidade da Marca
- **Confiavel** — estavel, credivel
- **Determinada** — focada em resultados
- **Sabia** — metodica, baseada em evidencia

### Paleta de Cores

| Token | Hex | RGB | Uso |
|-------|-----|-----|-----|
| Navy (primaria) | `#051C2C` | 5, 28, 44 | Backgrounds, texto, elementos primarios |
| Cyan/Turquoise (primaria) | `#23D8D3` | 35, 216, 211 | Accent, CTAs, highlights, marca |
| Gray (complementar) | `#A1A1A1` | 161, 161, 161 | Texto secundario, bordas |
| Ice/Off-white (complementar) | `#F3FBFF` | 243, 251, 255 | Fundos claros, cards |

### Tipografia
- **Space Grotesk** (Google Fonts) — Light 300, Regular 400, Medium 500, Bold 700
- **JetBrains Mono** para monospace (mantido do projeto original)

### Logo
- Icone: circulo incompleto (navy) + seta/chevron geometrica (cyan)
- Arquivos SVG em `public/logo-lever-full.svg`, `public/logo-lever-icon.svg`, `public/logo-lever-icon-mono.svg`
- Fonte original em `marca/MARCA LEVER/MARCA FINAL/RGB/SEM FUNDO/SVG/`

### Pattern
- Padrao geometrico de chevrons repetidos
- Cyan `#23D8D3` sobre fundo navy `#051C2C`

## Mudancas Implementadas

### 1. Fonte (Outfit → Space Grotesk)

**Arquivo:** `src/app/layout.tsx`
- Import: `Outfit` → `Space_Grotesk`
- Variable: `--font-outfit` → `--font-space-grotesk`

**Arquivo:** `src/app/globals.css`
- `--font-sans`: referencia atualizada para Space Grotesk

### 2. Design Tokens (globals.css)

#### Novos tokens de marca
```css
--color-brand:       #23D8D3;   /* cyan principal */
--color-brand-hover: #1ec5c0;   /* cyan hover */
--color-brand-faint: rgba(35, 216, 211, 0.10);  /* cyan sutil */
--color-navy:        #051C2C;   /* navy principal */
--color-navy-light:  #0a2d42;   /* navy hover */
```

#### Tokens atualizados (light mode)
| Token | Antes | Depois | Razao |
|-------|-------|--------|-------|
| `--color-ink` | `#1a1a2e` | `#051C2C` | Navy da marca como cor de texto |
| `--color-ink-muted` | `#6b7280` | `#4a6275` | Derivado do navy |
| `--color-ink-faint` | `#9ca3af` | `#8899a6` | Derivado do navy |
| `--color-surface` | `#fafafa` | `#F3FBFF` | Ice da marca |
| `--color-line` | `#e4e4e7` | `#d8e8f0` | Derivado do ice/navy |

#### Tokens atualizados (dark mode)
| Token | Antes | Depois | Razao |
|-------|-------|--------|-------|
| `--color-ink` | `#fafafa` | `#F3FBFF` | Ice da marca |
| `--color-ink-muted` | `#a1a1aa` | `#8899a6` | Complementar navy |
| `--color-ink-faint` | `#71717a` | `#4a6275` | Complementar navy |
| `--color-paper` | `#18181b` | `#051C2C` | Navy da marca como fundo dark |
| `--color-surface` | `#09090b` | `#071e2f` | Navy mais escuro |
| `--color-line` | `#27272a` | `#0f3049` | Navy intermediario |

#### Registrados no @theme inline
Todos os novos tokens (`brand`, `brand-hover`, `brand-faint`, `navy`, `navy-light`) estao registrados no `@theme inline` para uso como classes Tailwind: `bg-brand`, `text-navy`, `bg-brand-faint`, etc.

### 3. Botoes (globals.css)

#### `.btn-primary` — atualizado
- Background: `var(--color-ink)` → `var(--color-navy)` (navy solido)
- Color: `var(--color-paper)` → `#ffffff` (branco fixo)
- Hover: navy-light
- Focus ring: cyan da marca

#### `.btn-brand` — NOVO
- Background: `var(--color-brand)` (cyan)
- Color: `var(--color-navy)` (navy)
- Hover: `var(--color-brand-hover)` (cyan mais escuro)
- Uso: CTAs principais, acoes de destaque

### 4. Header (`src/components/app-header.tsx`)
- Linha accent: agora sempre presente (fallback para `var(--color-brand)` cyan)
- Logo: 32px → 36px (ligeiramente maior)

### 5. Login (`src/app/login/page.tsx`) — REDESIGN COMPLETO
- **Antes:** fundo zinc generico, card branco, botao dark generico
- **Depois:** fundo navy escuro, card navy com borda sutil, inputs dark, botao cyan `.btn-brand`, logo Lever grande

Detalhes:
- Fundo: `bg-navy`
- Card: `bg-[#071e2f]` com `border-[#0f3049]`
- Inputs: `bg-[#051C2C]` com focus cyan
- Botao submit: `.btn-brand` (cyan bg, navy text)
- Logo: `logo-lever-icon.svg` 72px
- Footer: "Lever Talents"

### 6. Tabs (`src/components/ui/tabs.tsx`)
- Container: `bg-zinc-100` → `bg-surface border border-line`
- Tab ativo: `bg-ink text-paper` → `bg-navy text-white`
- Contagem: `text-ink-faint` → `text-brand` (cyan) no tab ativo

### 7. Home Dashboard (`src/app/page.tsx`)
- Modulo SISO: accent `blue` → `brand` (cyan)
- Modulos Pedidos/Painel: accent `violet`/`red` → `navy`
- Stat icons: `text-ink-faint` → `text-brand` (cyan)

### 8. Input Focus Global (globals.css)
- Todos os inputs: caret-color usa `var(--color-brand)` (cyan)
- Focus: ring e border usam cyan em vez de zinc

### 9. Logos copiados para public/
- `public/logo-lever-full.svg` — logo completo horizontal (texto + icone)
- `public/logo-lever-icon.svg` — icone colorido (navy + cyan)
- `public/logo-lever-icon-mono.svg` — icone monocromatico (navy)

## Tailwind Classes Disponiveis

Apos esta mudanca, as seguintes classes Tailwind estao disponiveis:

```
bg-brand         → #23D8D3 (cyan)
bg-brand-hover   → #1ec5c0
bg-brand-faint   → rgba(35,216,211,0.10)
bg-navy          → #051C2C
bg-navy-light    → #0a2d42
text-brand       → #23D8D3
text-navy        → #051C2C
border-brand     → #23D8D3
border-navy      → #051C2C
```

## Nota sobre Zinc hardcoded

63 arquivos ainda usam classes `zinc-*` hardcoded (ex: `border-zinc-200`, `bg-zinc-50`). O override global de focus no CSS cobre inputs, mas o ideal e migrar progressivamente para os tokens semanticos (`bg-surface`, `border-line`, `text-ink`, etc.).

## Arquivos Modificados

| Arquivo | Tipo de mudanca |
|---------|-----------------|
| `src/app/layout.tsx` | Font import Space Grotesk |
| `src/app/globals.css` | Tokens, botoes, input focus |
| `src/components/app-header.tsx` | Accent line, logo size |
| `src/app/login/page.tsx` | Redesign completo |
| `src/components/ui/tabs.tsx` | Navy active, brand count |
| `src/app/page.tsx` | Module colors, stat icons |
| `public/logo-lever-full.svg` | NOVO — logo completo |
| `public/logo-lever-icon.svg` | NOVO — icone colorido |
| `public/logo-lever-icon-mono.svg` | NOVO — icone mono |
