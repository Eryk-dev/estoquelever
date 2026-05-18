# Design Changelog - SISO Estoque Lever

Registro de todas as melhorias de design aplicadas ao codigo e Figma.

**Figma file:** [Design-estoque-lever](https://www.figma.com/design/XXwdUwCMmaPLfX48rAmvHF/Design-estoque-lever)
**Brand identity:** `marca/IDENTIDADE VISUAL - LEVER TALENTS - comp.pdf`

## Changelogs

| # | Data | Titulo | Escopo |
|---|------|--------|--------|
| [001](001-brand-identity-lever.md) | 2026-04-02 | Brand Identity Lever Talents | Fonte, cores, tokens, login, header, tabs, home |

## Design System — Tokens de Referencia

### Cores da marca
| Token CSS | Tailwind | Hex | Uso |
|-----------|----------|-----|-----|
| `--color-brand` | `bg-brand` `text-brand` | `#23D8D3` | Accent, CTAs, highlights |
| `--color-brand-hover` | `bg-brand-hover` | `#1ec5c0` | Hover states |
| `--color-brand-faint` | `bg-brand-faint` | `rgba(35,216,211,0.10)` | Backgrounds sutis |
| `--color-navy` | `bg-navy` `text-navy` | `#051C2C` | Texto, fundos dark, botao primario |
| `--color-navy-light` | `bg-navy-light` | `#0a2d42` | Hover de elementos navy |

### Cores semanticas
| Token CSS | Tailwind | Light | Dark |
|-----------|----------|-------|------|
| `--color-ink` | `text-ink` | `#051C2C` | `#F3FBFF` |
| `--color-ink-muted` | `text-ink-muted` | `#4a6275` | `#8899a6` |
| `--color-ink-faint` | `text-ink-faint` | `#8899a6` | `#4a6275` |
| `--color-paper` | `bg-paper` | `#ffffff` | `#051C2C` |
| `--color-surface` | `bg-surface` | `#F3FBFF` | `#071e2f` |
| `--color-line` | `border-line` | `#d8e8f0` | `#0f3049` |

### Tipografia
| Variavel | Fonte | Uso |
|----------|-------|-----|
| `--font-sans` | Space Grotesk | Tudo exceto codigo |
| `--font-mono` | JetBrains Mono | SKUs, numeros, codigo |

### Classes utilitarias de botao
| Classe | Visual | Uso |
|--------|--------|-----|
| `.btn-primary` | Navy bg, white text | Acoes principais |
| `.btn-brand` | Cyan bg, navy text | CTAs de destaque |
| `.btn-ghost` | Transparente, border | Acoes secundarias |
| `.btn-danger-ghost` | Vermelho, border | Acoes destrutivas |

### Logos disponiveis
| Arquivo | Tipo | Quando usar |
|---------|------|-------------|
| `public/logo.svg` | Icone colorido (cropped) | Header, favicon |
| `public/logo-lever-icon.svg` | Icone completo (navy+cyan) | Login, splash |
| `public/logo-lever-full.svg` | Logo horizontal (texto+icone) | Materiais, rodape |
| `public/logo-lever-icon-mono.svg` | Icone monocromatico | Watermark, print |

## Status das Telas

| # | Tela | Frame ID | Status | Changelog |
|---|------|----------|--------|-----------|
| 1 | Login | 2:2 | Atualizado | [001](001-brand-identity-lever.md) |
| 2 | SISO Dashboard | 7:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 3 | Home Dashboard | 16:2 | Atualizado | [001](001-brand-identity-lever.md) |
| 4 | Pedidos | 18:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 5 | Compras | 19:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 6 | Inventario | 20:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 7 | Transferencias | 21:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 8 | Etiquetas | 22:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 9 | Configuracoes | 23:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 10 | Admin Usuarios | 24:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 11 | Painel Operacao | 31:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 12 | Painel Gerencial | 32:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 13 | Separacao - Pendentes | 45:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 14 | Separacao - Aguardando OC | 46:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 15 | Separacao - Pick OC | 47:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 16 | Separacao - Embalagem OC | 48:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 17 | Separacao - Checklist | 50:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 18 | Separacao - Embalagem | 51:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |
| 19 | Separacao - Separados | 53:2 | Tokens aplicados | [001](001-brand-identity-lever.md) |

**Legenda:** "Tokens aplicados" = mudancas globais (fonte, cores, header) afetam a tela via CSS tokens. "Atualizado" = tela teve mudancas especificas de componente.
