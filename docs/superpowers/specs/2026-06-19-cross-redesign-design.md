# Cross — camada de equivalência confiável (redesign do núcleo)

**Data:** 2026-06-19
**Status:** aprovado (brainstorming) — pronto pra virar plano TDD
**Ambiente:** staging (`ehbxpbeijofxtsbezwxd`, branch `develop`)
**Diagrama do fluxo:** `docs/superpowers/specs/2026-06-19-cross-redesign-fluxo.html`

---

## 1. O que é e por que

Cross = o dicionário de "qual peça substitui qual". É a base que alimenta **compras** (onde comprar mais barato), **separação** (o que mandar quando falta) e **troca** (mandar a peça certa). Hoje é uma tela de catálogo isolada, com bugs sérios, e **não** é a fonte de equivalência do sistema.

Este redesign transforma o cross na **camada de equivalência única** — um caderno só, que o cross e a troca compartilham.

### Os 6 problemas atuais (auditados contra o código em 2026-06-19, todos confirmados)

1. **Estoque vem do Tiny, não do ledger** — `src/lib/cross/catalogo-queries.ts:253` (`loadEstoquePorGalpao`) chama `getEstoque`/`buscarProdutoPorSku` da Tiny API; no `catch` faz `continue` e devolve vazio → Tiny offline aparece como "zero" real.
2. **Dois catálogos paralelos** — `siso_produtos_catalogo` (cross) ≠ `siso_produtos` (WMS). Sem FK, trigger ou reconciliação; divergem em silêncio.
3. **OEM por regex aceita lixo** — `src/lib/cross/oem-extractor.ts:20-30` (Estratégia 1, após rótulo "OEM:") chama só `isValidOemCode` (tamanho), pula `looksLikeOemCode` → aceita "ORIGINAL"/"1000"/"SIMILAR" como código. Insert é append-only (`ignoreDuplicates`) → lixo grudento.
4. **Equivalência por corrente cega** — função SQL `siso_cross_cluster_skus` (CTE recursiva, `oem && oem`, **sem cap de profundidade**) → funde A=C via ponte automaticamente, custo O(catálogo).
5. **Três endpoints de "equivalentes" divergentes** — `cross/produtos/[sku]/equivalentes-rapidos` (sem estoque), `compras/equivalentes` (ledger, todos galpões), `trocas/equivalentes` (ledger, 1 galpão).
6. **Sem auto-sync** — `sincronizado_em` é escrito e usado só em `ORDER BY`, nunca em staleness/WHERE.

---

## 2. Decisões travadas

| # | Decisão |
|---|---|
| **C** | **Um caderno novo, do zero**, fonte única pra cross **e** troca. Reformular as conexões dos dois. |
| **Motor de troca intocado** | O RPC atômico de reserva de estoque (`wms_aprovar_troca_atomico`) **não muda**. Só muda **de onde a regra lê** "essa peça vira aquela" (passa a ler o caderno novo). |
| **Zero auto-merge** | Toda ligação nasce **palpite**. Vira verdade **só** por confirmação humana. Confiança (futuro) só ordena a fila, nunca confirma. |
| **Sem transitividade automática** | "Equivalentes de X" = ligações **diretas** do caderno. A=C via ponte nunca funde sozinho (pode virar palpite via importador, depois). Mata `siso_cross_cluster_skus` do caminho. |
| **Mostrar tudo** | Cross **e** troca mostram **palpite + confirmado**. "Só validado" é um modo futuro (quando a base estiver madura). Hoje filtrar só validado deixaria a tela vazia. |
| **Errar nos palpites é ok** | Porque toda equivalência passa por um humano antes de virar troca real. Na troca: palpite aparece mas **exige aprovação**; confirmado+mesma linha = direto; proibido = nunca. |
| **Estoque = ledger** | Toda tela de cross mostra **nosso** estoque via `aggregateLiveStockBySku` (`src/lib/wms/live-stock.ts`). Mata o caminho que lia Tiny. |
| **Fornecedor: nada agora** | Não mostrar oferta/preço/estoque de fornecedor no núcleo. |
| **Caderno começa vazio** | Sem importador e sem palpite automático no núcleo. Eryk preenche à mão; importadores (ACA, OEM) são floreio. |
| **D10 — quem confirma** | Curadoria gateada por `vendas.aprovar_troca`. Sem código de permissão novo. |
| **Pendura em `siso_produtos`** | O caderno referencia o catálogo principal (`siso_produtos.sku`), não o catálogo sujo do cross. |

---

## 3. Modelo de dados

### Tabela nova: `siso_cross_equivalencias`

O "caderno". Cada linha = uma ligação entre duas peças.

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | bigserial PK | |
| `sku_a` | text NOT NULL | FK → `siso_produtos(sku)` |
| `sku_b` | text NOT NULL | FK → `siso_produtos(sku)` |
| `relacao` | text NOT NULL DEFAULT `'equivalente'` | CHECK em (`'equivalente'`) por ora; expande por migration |
| `status` | text NOT NULL DEFAULT `'sugestao'` | CHECK em (`'sugestao'`,`'confirmado'`,`'bloqueado'`) |
| `fonte` | text NOT NULL DEFAULT `'manual'` | proveniência: `manual` no núcleo; futuro `aca`, `oem_auto`, `migracao_troca`… |
| `observacao` | text NULL | nota humana (ex.: motivo do bloqueio) |
| `criado_por` | uuid NULL | FK → `siso_usuarios` |
| `criado_em` | timestamptz NOT NULL DEFAULT now() | |
| `decidido_por` | uuid NULL | FK → `siso_usuarios`; setado ao confirmar/bloquear |
| `decidido_em` | timestamptz NULL | |
| `atualizado_em` | timestamptz NOT NULL DEFAULT now() | |

**Constraints/índices:** `CHECK (sku_a < sku_b)` · `UNIQUE (sku_a, sku_b)` · índice em `sku_a`, em `sku_b`, em `status` (fila).

**Par normalizado** (a<b) → uma linha por par, sem duplicar A↔B.

### Transições de estado (proveniência + reversível — D7)

```
(criar)          → sugestao        [produtos.editar]
sugestao         → confirmado      [vendas.aprovar_troca]  (set decidido_por/em)
sugestao         → bloqueado       [vendas.aprovar_troca]  (set decidido_por/em)
confirmado       → sugestao        [vendas.aprovar_troca]  (desfaz; limpa decidido_*)   ← "revogar"
bloqueado        → sugestao        [vendas.aprovar_troca]  (desbloqueia)
(remover linha)  delete            [produtos.editar p/ palpite próprio; vendas.aprovar_troca p/ qualquer]
```

### Seed (migração)

Migra **só o que já foi validado na mão** na troca, de `siso_equivalencias_verificadas`:
`verificado → confirmado`, `bloqueado → bloqueado`, `fonte='migracao_troca'`, `decidido_por/em` do registro antigo. **Só pares cujos dois SKUs existem em `siso_produtos`** (resto: log + pula). **Descarta** todo o dado sujo do cross (catálogo, OEM, veículo, link extraídos).

---

## 4. Serviço único (uma função, um caminho)

`src/lib/cross/equivalencias.ts` (novo) — `equivalentesDaPeca(supabase, sku, { galpaoId? })`:

- **Equivalentes** = linhas do caderno onde `sku_a = sku` OU `sku_b = sku` (qualquer status). **A visão de troca oculta `bloqueado`** (nunca troca); a fila/ficha do cross **mostra** `bloqueado` (pra poder desbloquear). **Só diretas, sem corrente.**
- **Dados do produto** (descrição, imagem, `tier_qualidade`) vêm de `siso_produtos`.
- **Estoque** (nosso e de cada equivalente) vem do **ledger** via `aggregateLiveStockBySku`. `galpaoId` filtra; sem ele, agrega todos.
- Retorna: `{ sku, status_por_par, nossoEstoquePorGalpao, equivalentes: [{ sku, relacao, status, descricao, imagem, tier, estoquePorGalpao, fonte, decidido_por }] }`.

Esse serviço é a **única** fonte de "equivalentes". Os 3 endpoints antigos passam a chamá-lo (ou colapsam):
- `cross/produtos/[sku]/equivalentes-rapidos` → usa o serviço (ou é substituído por `cross/produtos/[sku]`).
- `compras/equivalentes` → troca a fonte de equivalência pro caderno (estoque já vem do ledger — manter).
- `trocas/equivalentes` → idem, com `galpaoId`.

---

## 5. Endpoints (API)

**Novos:**
- `POST /api/wms/cross/ligar` `{ sku_a, sku_b }` → cria palpite. **`produtos.editar`**.
- `GET  /api/wms/cross/fila` → lista palpites pra curar. (ver: `produtos.editar`; agir: `vendas.aprovar_troca`)
- `POST /api/wms/cross/[id]/confirmar` → palpite→confirmado. **`vendas.aprovar_troca`**.
- `POST /api/wms/cross/[id]/bloquear` `{ observacao? }` → →bloqueado. **`vendas.aprovar_troca`**.
- `POST /api/wms/cross/[id]/desfazer` → confirmado/bloqueado→sugestao. **`vendas.aprovar_troca`**.
- `DELETE /api/wms/cross/[id]` → remove palpite. (`produtos.editar` p/ próprio; `vendas.aprovar_troca` p/ qualquer)
- `GET  /api/wms/cross/produtos/[sku]` → ficha completa (serviço). (substitui/refaz o atual)

**Mudados:** `compras/equivalentes`, `trocas/equivalentes` (fonte de equivalência → caderno). `cross/produtos/[sku]/has-cross` → "existe par no caderno?" (sem cluster fn).

**Retirados (depois do rewire):** `cross/produtos/[sku]/equivalentes-rapidos` (se colapsado).

---

## 6. Troca — o que muda e o que NÃO muda

- **NÃO muda:** `wms_aprovar_troca_atomico` (reserva atômica L+R), `wms_encerrar_troca_atomico`, `wms_trocar_substituto_atomico`, a entidade `siso_trocas_equivalencia` (pedido de troca por item), e a **lógica de tier** em `trocas-equivalencia-regra.ts` (mesmo tier + par confirmado = livre; diferença/sem classificação/par não-confirmado = aprovação humana; bloqueado = nunca).
- **Muda:** a fonte do "par é confirmado?" — o caller (`trocas-equivalencia.ts`) passa a ler `status='confirmado'` no caderno novo em vez de `siso_equivalencias_verificadas`. As listas (`listarEquivalentesComEstoque`, `listarEquivalentesParaCompra`) passam pelo serviço único e **mostram palpites também** (com selo); usar um palpite cai na trilha de aprovação que já existe.
- **Nota de desenho (default simples):** aprovar a troca de **um pedido** sobre um par palpite **não** promove o par a confirmado globalmente. Promoção do dicionário é ato separado, na fila do cross. (Pode-se oferecer "confirmar também no dicionário?" depois — fora do núcleo.)

---

## 7. Estoque sempre o nosso; mata o Tiny

- `loadEstoquePorGalpao` / `getEstoquePorGalpaoParaSku` (`catalogo-queries.ts`) → **deletados**; estoque vem de `aggregateLiveStockBySku`.
- `produto-fetcher.ts` (busca Tiny + grava no catálogo sujo) e `oem-extractor.ts` → **retirados** (alimentavam o catálogo que vamos aposentar).
- Teste garante que o caminho de cross **não importa** `@/lib/tiny-api`.

---

## 8. O que se aposenta (opção C)

Depois de religar todos os consumidores ao caderno + serviço, e migrar o seed:

- Tabelas: `siso_produtos_catalogo`, `siso_produto_oems`, `siso_produto_veiculos`, `siso_produto_links`, `siso_equivalencias_verificadas`.
- Função: `siso_cross_cluster_skus`.
- Libs: `produto-fetcher.ts`, `oem-extractor.ts`, partes de `catalogo-queries.ts`.

Drop físico das tabelas/função = **último passo**, só quando nada mais as lê.

---

## 9. Irradiação (D8 — básica no núcleo)

Caderno é um só → confirmar irradia de imediato, sem infra nova:
- **Ficha do produto** (produto-drawer) mostra a seção Cross.
- **Página do cross** e **popover** refletem o estado.
- **Troca** lê o mesmo caderno → confirmar um cross **destrava a troca na hora**.
- Cliente: invalidar caches React Query nos pontos que consomem cross após confirmar/desfazer.

**Fora do núcleo (floreio #6):** virar código de compra no fornecedor, recalcular necessidade, re-rotear pedido preso. Padrão fire-and-forget (estilo reconciliador-OC) quando entrar.

---

## 10. Telas (padrão `wms-*` do app)

1. **`/wms/cross`** — busca (SKU/OEM/nome), **galeria** de peças com foto + selo (confirmado / palpite / sem cross); cartões "aguardando validação / confirmadas / sem cross". Nunca em branco.
2. **`/wms/cross/[sku]`** — ficha da peça: foto + nosso estoque (ledger) + equivalentes (com estoque) + "Ligar peça". Sem bloco de fornecedor.
3. **Seção Cross no `produto-drawer.tsx`** (4 telas já o usam) — resumo + "abrir ficha →" + "Ligar peça".
4. **Fila de validação** — reusa `ProdutoComparador`/`ProdutoLightbox` (`produto-lightbox.tsx`): foto A ↔ B, contexto ("ligado à mão por…"), botões **✗ não / pular / ✓ é a mesma**, anda sozinho, atalhos de teclado.

---

## 11. Permissões

Sem código novo no registry.
- **Ligar peça** (criar palpite) = `produtos.editar`.
- **Confirmar / bloquear / desfazer** = `vendas.aprovar_troca`.

Frontend: `usePermissoes().can(...)`; sidebar/itens gateados. Backend: `userCan`.

---

## 12. Testes (TDD)

**Unit (vitest):**
- Par normaliza A<B; UNIQUE impede duplicar A↔B.
- Transições: sugestao→confirmado→sugestao (desfaz); sugestao→bloqueado.
- `equivalentesDaPeca` retorna só ligações **diretas** (sem corrente); junta estoque do ledger.
- Caminho de cross **não chama Tiny** (assert sem import/uso de `tiny-api`).
- Regra de troca lê `confirmado` do caderno; `bloqueado` = nunca; palpite = exige aprovação.

**Integração / cenários (staging real):**
- Ligar → fila → confirmar → troca passa a tratar o par como livre.
- Desfazer → reverte (troca volta a exigir aprovação).
- Bloquear → troca nunca oferece.
- Seed: pares validados da troca aparecem como `confirmado` no caderno.

---

## 13. Sequenciamento sugerido (writing-plans detalha)

1. **Caderno + serviço + testes** — tabela `siso_cross_equivalencias`, `equivalentesDaPeca` (ledger), unit tests. *Verifica:* testes verdes; serviço lê ledger, não Tiny.
2. **Endpoints + permissões** — ligar/confirmar/bloquear/desfazer/fila/ficha. *Verifica:* auth-matrix; cenários ligar→confirmar.
3. **Religar troca + compras ao caderno** (sem tocar o RPC atômico) + migrar seed. *Verifica:* cenários de troca passam lendo o caderno; pares validados migrados.
4. **Telas** — `/wms/cross`, ficha, seção no drawer, fila com comparador. *Verifica:* mostra palpite+confirmado; estoque do ledger.
5. **Matar Tiny + aposentar tabelas/função antigas** (drop por último). *Verifica:* nada importa `tiny-api` no cross; build/lint; nada referencia as tabelas dropadas.

---

## 14. Docs a atualizar no mesmo commit

- `docs/database-schema.md` — nova tabela; tabelas/função removidas.
- `docs/api-reference-complete.md` — novos endpoints; mudados/removidos.
- `docs/architecture-and-flows.md` — cross como camada de equivalência; troca lê o caderno.
- `erros-conhecidos.yaml` — registrar os 6 problemas corrigidos (estoque-Tiny, OEM over-merge, corrente sem cap, etc.).

---

## 15. Fora do escopo (floreios — depois, encaixam sem refazer o núcleo)

Importar ACA completa (interchange+fitment) · palpite automático por OEM · fila priorizada por lucro + tela de lote · vários fornecedores (1 adaptador cada) + confiança por corroboração · oferta de fornecedor (preço+disponibilidade) · ações automáticas ao aprovar (código de compra, re-roteio) · match por nome/specs com pgvector.
