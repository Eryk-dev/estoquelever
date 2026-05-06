# Cross — Módulo de catálogo, OEMs e equivalência de produtos

**Status:** approved (brainstorming) — pendente de plano de implementação
**Data:** 2026-05-06
**Autor:** Eryk + Claude
**Origem:** projeto externo `/Users/eryk/Documents/ESTOQUE/cross/` (MeliTools), do qual portamos a parte de busca/equivalência por OEM. Tudo o que toca MercadoLivre, IA e analytics fica de fora.

---

## 1. Visão geral

Novo módulo dentro do app SISO, acessível em `/cross`, que dá ao operador uma ferramenta rápida para:

- buscar um produto por **SKU, OEM ou nome**;
- ver foto, descrição, OEMs, compatibilidade veicular e **estoque por galpão**;
- ver **outros SKUs equivalentes** (que compartilham pelo menos um OEM);
- **adicionar/remover OEMs e veículos** pela própria UI;
- (fase 2) **substituir um item em separação**, com estorno e baixa automáticos no Tiny.

O módulo é 100% nativo do SISO: mesmo Next.js, mesmo Supabase, mesmas convenções (`siso_*`, AppShell, PIN, Sonner, Lucide). Não cria novo serviço, processo ou deploy. O projeto `cross/` clonado em raiz do repositório serve apenas como referência de código e fonte do seed inicial.

### 1.1 Escopo do MVP1 (esta entrega)

| Inclui | Não inclui |
|---|---|
| Página `/cross` com busca universal e listagem de resultados | Integração com fluxo de separação (MVP2) |
| Página `/cross/[sku]` com detalhe completo e edição | Qualquer integração com MercadoLivre |
| Catálogo `siso_produtos_catalogo` populado lazy + seed inicial do projeto cross | IA / geração de descrição |
| CRUD de OEMs e veículos com audit por usuário | Job recorrente de sync com Tiny |
| Refetch do Tiny apenas sob demanda (botão "Atualizar agora") | Catálogo pré-populado de marcas/modelos |
| Item "Cross" no menu lateral (ícone Lucide `Search`) | Dashboard de analytics |
| Aviso quando OEM cadastrado já existe em outro SKU (cruzamento) | Atualização automática (TTL) |
| Tabela `siso_cross_logs` (telemetria com identificação do usuário) | |

### 1.2 Escopo do MVP2 (fase posterior, dividida)

#### 1.2.1 MVP2.1 — UI de substituição na separação
- Ícone "Ver equivalentes" no card de item da separação (reutilizando padrão visual de `compras/trocar-sku`)
- Drawer/dialog mostra a lista de equivalentes vinda do Cross + opção de digitar SKU livre (mantendo paridade com o trocar-sku atual)
- Endpoint `POST /api/separacao/trocar-sku-item` (espelho do `/api/compras/trocar-sku`, adaptado pra separação): atualiza `siso_pedido_itens` (SKU, descrição, imagem, fornecedor) e `siso_pedido_item_estoques`
- Tabela `siso_pedido_substituicoes` (auditoria: quem, quando, original, substituto, qtd, motivo)
- Suporta substituição parcial (split em duas linhas: parte substituída + parte ainda original)
- Operador pode desfazer enquanto o pedido não foi expedido; admin pode desfazer sempre

#### 1.2.2 MVP2.2 — Movimentação de estoque no Tiny (decisão fiscal pendente)
**Adiado.** Decidir depois entre dois caminhos:
- **Via NF** (formal): cancelar/emitir NFs para estorno do original e baixa do substituto
- **Ajuste direto via Tiny `ajustar-estoque`**: simples mas gera divergência fiscal/contábil

Até essa decisão acontecer, MVP2.1 funciona em modo "registra a substituição no SISO sem tocar o Tiny" — o time resolve a parte fiscal/operacional como faz hoje.

### 1.3 Princípios preservados do estoque-lever

1. Stack único: tudo dentro do Next.js do SISO
2. Tabelas com prefixo `siso_*`
3. Auth via PIN + `getSessionUser()` + `X-Session-Id`
4. Logger estruturado (`logger.info/warn/error/logError`) — nunca `console.log`
5. Hierarquia galpão/empresa/grupo respeitada (estoque agregado via `grupo-resolver.ts`)
6. Documentação atualizada (`docs/api-reference-complete.md`, `docs/database-schema.md`, `CLAUDE.md`)

---

## 2. Modelo de dados

Todas as tabelas no schema público com prefixo `siso_*`.

### 2.1 `siso_produtos_catalogo`

Cache desnormalizado por SKU. Uma linha por produto.

```sql
CREATE TABLE siso_produtos_catalogo (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku               text NOT NULL UNIQUE,
  tiny_id           bigint UNIQUE,                -- ID Tiny para refetch
  nome              text NOT NULL,
  descricao         text,
  fornecedor        text,                          -- de sku-fornecedor.ts
  marca             text,
  imagem_url        text,
  gtin              text,
  oem               text[] NOT NULL DEFAULT '{}', -- denormalizado (trigger)
  compatibility_v2  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- denormalizado (trigger)
  sincronizado_em   timestamptz,                  -- última vez que veio do Tiny (apenas diagnóstico)
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_produtos_catalogo_oem_gin ON siso_produtos_catalogo USING gin (oem);
CREATE INDEX idx_produtos_catalogo_nome_trgm ON siso_produtos_catalogo USING gin (nome gin_trgm_ops);
CREATE INDEX idx_produtos_catalogo_sku_trgm ON siso_produtos_catalogo USING gin (sku gin_trgm_ops);
```

Requer extensão `pg_trgm` para busca por nome com similaridade.

### 2.2 `siso_produto_oems` — fonte de verdade dos OEMs

```sql
CREATE TABLE siso_produto_oems (
  id              bigserial PRIMARY KEY,
  produto_sku     text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  oem_code        text NOT NULL,
  origem          text NOT NULL CHECK (origem IN ('extracao_tiny','manual')),
  adicionado_por  uuid REFERENCES siso_usuarios(id),  -- NULL para 'extracao_tiny'
  adicionado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_sku, oem_code)
);

CREATE INDEX idx_produto_oems_oem ON siso_produto_oems(oem_code);
```

**Regra de remoção:** operador só pode remover OEM com `origem='manual' AND adicionado_por=session_user.id`. Cargo `admin` pode remover qualquer um. Aplicada no endpoint, não no banco.

**Trigger:** `AFTER INSERT OR DELETE ON siso_produto_oems` chama função PL/pgSQL que recomputa o array `siso_produtos_catalogo.oem` para o `produto_sku` afetado.

### 2.3 `siso_produto_veiculos` — fonte de verdade veicular

```sql
CREATE TABLE siso_produto_veiculos (
  id              bigserial PRIMARY KEY,
  produto_sku     text NOT NULL REFERENCES siso_produtos_catalogo(sku) ON DELETE CASCADE,
  marca           text NOT NULL,
  modelo          text NOT NULL,
  ano_inicio      int,
  ano_fim         int,
  variante        text,
  adicionado_por  uuid REFERENCES siso_usuarios(id),
  adicionado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_sku, marca, modelo, ano_inicio, ano_fim, variante)
);

CREATE INDEX idx_produto_veiculos_marca_modelo ON siso_produto_veiculos(marca, modelo);
```

Trigger análogo recomputa `siso_produtos_catalogo.compatibility_v2` (formato JSONB compatível com o schema do cross para facilitar futuras integrações se reativarmos MLB).

### 2.4 `siso_cross_logs` — telemetria de uso (opcional)

```sql
CREATE TABLE siso_cross_logs (
  id               bigserial PRIMARY KEY,
  query_tipo       text NOT NULL CHECK (query_tipo IN ('sku','oem','nome','auto')),
  query_texto      text NOT NULL,
  resultado_count  int NOT NULL,
  usuario_id       uuid REFERENCES siso_usuarios(id),
  criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cross_logs_criado_em ON siso_cross_logs(criado_em DESC);
```

Útil para identificar SKUs frios e padrões de busca. Não afeta o fluxo do operador. Pode ser cortado se preferir simplicidade — não tem dependentes.

### 2.5 (MVP2.1) `siso_pedido_substituicoes`

Definida em detalhe na **Seção 6.5**. Criada apenas quando o MVP2.1 entrar.

---

## 3. API (rotas Next.js)

Todas em `src/app/api/cross/`, autenticadas via `getSessionUser()`, usando `createServiceClient()`.

### 3.1 Busca

#### `GET /api/cross/search?q=<texto>&tipo=auto|sku|oem|nome`

Busca universal. `tipo=auto` (default) executa as três estratégias em paralelo e mescla resultados, dedup por SKU.

**Resposta:**
```ts
{
  query: string,
  tipo_detectado: 'sku' | 'oem' | 'nome',
  total: number,
  resultados: Array<{
    sku: string,
    nome: string,
    fornecedor: string | null,
    marca: string | null,
    imagem_url: string | null,
    oems: string[],
    estoque_total: number,
    match: 'sku_exato' | 'oem' | 'nome'
  }>
}
```

Ordenação: `sku_exato` → `oem` → `nome` (por similaridade). Estoque agregado já vem na resposta para ordenação secundária por disponibilidade.

#### `GET /api/cross/produtos/:sku`

Detalhe completo. Se SKU não existe em `siso_produtos_catalogo`, dispara busca **lazy** no Tiny (Seção 5).

**Resposta:**
```ts
{
  sku, nome, descricao, fornecedor, marca, imagem_url, gtin,
  sincronizado_em: string | null,
  oems: Array<{
    codigo: string,
    origem: 'extracao_tiny' | 'manual',
    adicionado_por_nome: string | null,
    adicionado_em: string,
    pode_remover: boolean
  }>,
  veiculos: Array<{
    id: number,
    marca, modelo,
    ano_inicio: number | null,
    ano_fim: number | null,
    variante: string | null,
    adicionado_por_nome: string | null,
    adicionado_em: string,
    pode_remover: boolean
  }>,
  estoque_por_galpao: Record<string, {
    saldo: number,
    reservado: number,
    disponivel: number,
    deposito_nome: string | null,
    localizacao: string | null
  }>,
  equivalentes: Array<{
    sku, nome, imagem_url,
    oems_compartilhados: string[],
    estoque_por_galpao: Record<string, { saldo, reservado, disponivel }>
  }>
}
```

Estoque por galpão usa o stack já existente do SISO: `getEmpresasDoGrupo` + `getEstoque` + `agregarEstoquePorGalpao`. Sem reinventar.

`pode_remover` calculado server-side: `origem === 'manual' && adicionado_por === user.id || user.cargo === 'admin'`.

`equivalentes`: `WHERE oem && $1::text[] AND sku <> $2`, ordenados por `estoque_total DESC`, limitado a 50.

### 3.2 Edição de OEMs

#### `POST /api/cross/produtos/:sku/oems`
Body: `{ codigo: string }`. Insere com `origem='manual'`, `adicionado_por=user.id`. Validação client + server: regex `/^[A-Z0-9.\-]{4,30}$/i`, normaliza para uppercase.

#### `DELETE /api/cross/produtos/:sku/oems/:codigo`
Aplica regra de permissão. 403 se violar.

### 3.3 Edição de veículos

#### `POST /api/cross/produtos/:sku/veiculos`
Body: `{ marca, modelo, ano_inicio?, ano_fim?, variante? }`. Normaliza strings (`trim` + `upperCase` para marca/modelo).

#### `DELETE /api/cross/produtos/:sku/veiculos/:id`
Aplica regra de permissão.

### 3.4 Refetch manual

#### `POST /api/cross/produtos/:sku/refetch`
Único caminho de atualização do cache a partir do Tiny. Executa de forma **bloqueante** e devolve detalhe atualizado. Disparado pelo botão "Atualizar agora" no header do detalhe. Não há TTL automático no MVP1.

### 3.5 Helpers de UI

#### `GET /api/cross/sugestoes/marcas?q=<prefixo>`
`SELECT DISTINCT marca FROM siso_produto_veiculos WHERE marca ILIKE $1 || '%' LIMIT 20`.

#### `GET /api/cross/sugestoes/modelos?marca=<marca>&q=<prefixo>`
Análogo, filtrando por marca.

### 3.6 Permissões

| Endpoint | Cargos |
|---|---|
| `GET /search`, `GET /produtos/:sku`, `GET /sugestoes/*` | Todos logados (admin + operadores + comprador) |
| `POST /oems`, `POST /veiculos` | Todos logados |
| `DELETE /oems`, `DELETE /veiculos` | Operador remove só o que **ele mesmo** cadastrou; **admin remove qualquer um** |
| `POST /refetch` | Todos logados |

Sem filtro por galpão na busca: operador CWB enxerga estoque de SP e vice-versa (caso de uso é justamente achar substituto em outro galpão).

### 3.7 Aviso de cruzamento de OEM

No `POST /oems`, depois de inserir, o endpoint executa uma checagem:
`SELECT sku FROM siso_produto_oems WHERE oem_code = $1 AND produto_sku <> $2 LIMIT 5`.
Se houver resultado, devolve no response:
```ts
{ ok: true, cruzamentos: [{ sku: 'NETPARTS-9999', nome: '...' }, ...] }
```
A UI mostra toast com link para os SKUs cruzados. Operador percebe que acabou de criar uma equivalência valiosa.

---

## 4. UI / fluxo

### 4.1 Estrutura de rotas

```
src/app/cross/
  page.tsx               # Tela principal (busca + lista)
  [sku]/page.tsx         # Detalhe do produto
```

Ambas `"use client"` (padrão SISO).

### 4.2 Tela principal `/cross`

**Layout** (`max-w-3xl mx-auto px-4 py-6`, mobile-first):

- Input de busca grande, com ícone Lucide `Search`, autofocus, placeholder "SKU, OEM ou nome do produto", debounce 300ms
- Pílulas de tipo: `Auto · SKU · OEM · Nome` (default `Auto`)
- Lista de resultados (cards densos):
  - Foto miniatura à esquerda
  - SKU em fonte mono, nome do produto, fornecedor
  - OEMs como chips pequenos
  - Estoque por galpão em uma linha (`CWB: 5 · SP: 3`)
  - Badge de match: `via SKU` / `via OEM` / `via nome`
- Click no card → navega para `/cross/[sku]`
- Empty state inicial: dica de uso + atalho `/` para focar input
- Empty state pós-busca sem resultado: mensagem + botão "Forçar consulta no Tiny" (chama `/refetch` se a query for um SKU exato)

### 4.3 Tela de detalhe `/cross/[sku]`

Cinco seções verticais, cada uma um card com `rounded-lg border border-zinc-200 dark:border-zinc-800 p-4`:

1. **Header**: foto + nome + GTIN + "Sincronizado há Xh" + botão `↻ Atualizar agora`
2. **Estoque por galpão**: tabela compacta — galpão, localização, saldo, reservado, disponível
3. **Códigos OEM**: lista de chips, cada um com origem (`extracao_tiny` em cinza, `manual` em zinc-700) e botão `×` quando `pode_remover`. Botão `+ adicionar OEM` abre input inline com Enter para confirmar
4. **Compatibilidade veicular**: lista de chips formatados como "MARCA MODELO ANO_INI-ANO_FIM Variante", com botão `×`. `+ adicionar veículo` abre form inline (4 inputs em linha + variante)
5. **Equivalentes**: lista de produtos com mesmo OEM, mostrando SKU, nome, foto pequena, estoque por galpão, OEMs compartilhados

### 4.4 Interações

- **Adicionar OEM/veículo**: update otimista na UI, toast `success` na confirmação, rollback + toast `error` em falha
- **Remover**: `confirm()` nativo (sem modal pesado no MVP)
- **Autocomplete marca/modelo**: HTML `<datalist>` populado por `/api/cross/sugestoes/*`
- **Atalhos**: `/` em qualquer tela do módulo foca input; `Esc` no detalhe volta à lista; `Enter` no input executa busca imediata

### 4.5 Navegação

Adicionar item "Cross" no menu da `AppShell` entre **Pedidos** e **Inventário**, com ícone Lucide `Search`.

### 4.6 Componentes novos

```
src/components/cross/
  search-input.tsx           # Input + pílulas de tipo
  resultado-card.tsx         # Card na lista
  produto-header.tsx         # Card de header no detalhe
  estoque-galpao-tabela.tsx  # Tabela de estoque
  oem-list-editor.tsx        # Lista + editor inline de OEMs
  veiculo-list-editor.tsx    # Lista + editor inline de veículos
  equivalentes-list.tsx      # Lista de equivalentes
```

Sem biblioteca de componentes — Tailwind direto, padrão SISO. Sonner para toasts, Lucide para ícones.

---

## 5. População e sincronização

### 5.1 Seed inicial (uma vez)

Script `scripts/seed-cross-catalogo.ts` executado fora do app (via `tsx scripts/...` ou `npm run seed:cross`):

1. Conecta ao Supabase via `createServiceClient()`
2. Lê `cross.products` (mesmo banco): `sku`, `tiny_id`, `product_name`, `description`, `supplier`, `manufacturer`, `pictures`, `oem`, `compatibility_v2`, `gtin`, `updated_at`
3. Faz `upsert` em `siso_produtos_catalogo` (`pictures[0] → imagem_url`, `product_name → nome`, etc.)
4. Para cada item de `oem text[]`, insere em `siso_produto_oems` com `origem='extracao_tiny'`, `adicionado_por=NULL`
5. Lê `cross.oem_metadata`. Para cada `(sku, oem_code, added_by_email)`:
   - `SELECT id FROM siso_usuarios WHERE email = added_by_email`
   - Se achou: `UPDATE siso_produto_oems SET origem='manual', adicionado_por=user_id WHERE produto_sku=sku AND oem_code=oem_code`
   - Se não achou: deixa como `extracao_tiny` (não preserva `manual` órfão)
6. Para cada `compatibility_v2.vehicles[]`, insere em `siso_produto_veiculos`
7. Marca `sincronizado_em = now()`
8. Imprime relatório: `X produtos, Y OEMs (Z manuais), W veículos`

Idempotente: rodar de novo só atualiza, nada se perde.

### 5.2 Lazy fetch (durante uso normal)

Quando `GET /produtos/:sku` recebe SKU não cacheado:

```
1. Resolve empresa de origem do operador (do session/galpão)
2. tiny-api.buscarProdutoPorSku(token, sku) → 404 se não existir
3. tiny-api.getProdutoDetalhe(token, produto.id) → imagem, gtin, descricao_complementar
4. extrairOEMs(descricao_complementar) → string[]
5. INSERT em siso_produtos_catalogo
6. INSERT em siso_produto_oems (todos com origem='extracao_tiny')
7. Trigger atualiza array oem
8. Devolve detalhe enriquecido
```

Custo da primeira busca: ~1-3s. Subsequentes: instantâneo. Erro do Tiny não bloqueia: retorna o que foi possível com `sincronizado_em=null` e flag `parcial=true`.

### 5.3 Refresh manual (sem TTL automático)

Não há atualização automática no MVP1. Cache do produto é atualizado **apenas** quando:

- O produto não existia em `siso_produtos_catalogo` e alguém busca pela primeira vez (lazy fetch — Seção 5.2)
- Operador clica no botão "Atualizar agora" no header do detalhe → `POST /api/cross/produtos/:sku/refetch` (bloqueante)

Coluna `sincronizado_em` continua existindo para diagnóstico (mostrar "última atualização há Xh") mas não dispara comportamento automático.

**Comportamento quando o Tiny está fora do ar** (lazy ou refetch manual):
- `GET /produtos/:sku` para SKU **não cacheado** → devolve `503` com mensagem clara `"Tiny indisponível, tente em alguns minutos"`. Não tenta retry agressivo. Sem dados parciais salvos.
- `POST /refetch` para SKU **já cacheado** → mesma mensagem; cache existente fica intacto.

### 5.4 Extração de OEM da descrição

Função `extrairOEMs(descricao: string): string[]` em `src/lib/cross/oem-extractor.ts`. Porta direta de `cross/backend/src/services/tiny/product-operations.ts:15-78`.

Lógica:
- Regex 1: `/OEM[:<\s]+([A-Z0-9][A-Z0-9\s\-.]+)/i` — captura linha "OEM: ABC123 DEF456"
- Regex 2 (fallback): linhas que parecem códigos de fabricante (uppercase + dígitos + traço, 4-15 chars)
- Filtra duplicatas, normaliza para uppercase

Cobertura mínima: 6-8 unit tests com descrições reais extraídas de produtos do Tiny.

### 5.5 Política: refetch nunca remove

Quando refetch traz uma nova lista de OEMs do Tiny:

- OEMs **novos** (não existentes em `siso_produto_oems` para esse SKU): inserir com `origem='extracao_tiny'`
- OEMs **existentes**: ignorar
- OEMs **em cache mas não no Tiny**: **não remover**

Mesmo princípio para veículos. Trade-off: pode acumular dados obsoletos; em troca, nunca destrói trabalho do operador. Operador limpa manualmente se quiser.

### 5.6 Triggers

```sql
CREATE FUNCTION siso_recalcular_oems_produto(p_sku text) RETURNS void AS $$
BEGIN
  UPDATE siso_produtos_catalogo
  SET oem = COALESCE(
    (SELECT array_agg(DISTINCT oem_code ORDER BY oem_code)
     FROM siso_produto_oems WHERE produto_sku = p_sku),
    '{}'
  ),
  atualizado_em = now()
  WHERE sku = p_sku;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalc_oems_after_change
AFTER INSERT OR DELETE ON siso_produto_oems
FOR EACH ROW EXECUTE FUNCTION siso_trigger_recalc_oems();
```

(Função wrapper `siso_trigger_recalc_oems` extrai `produto_sku` do `NEW` ou `OLD` e chama a recalculadora.) Análogo para veículos → `compatibility_v2`.

---

## 6. Integração futura na separação (MVP2 — visão)

**Não implementado no MVP1.** Documentado para garantir que o desenho atual não bloqueia a fase 2. Dividido em dois sub-MVPs:

- **MVP2.1** — UI de substituição na separação + atualização do `siso_pedido_itens` (sem tocar Tiny)
- **MVP2.2** — Movimentação de estoque no Tiny (estorno + baixa) — adiada por dependência fiscal

### 6.1 Padrão reaproveitado

Existe hoje em `src/app/api/compras/trocar-sku/route.ts` um fluxo que **troca o SKU de um item de pedido** atualizando `siso_pedido_itens` (SKU, descrição, imagem, fornecedor) e re-buscando estoque por empresa do grupo. **Não toca o Tiny.** É o padrão que o MVP2.1 espelha.

A diferença em separação: em vez do operador digitar o SKU substituto a frio, ele recebe a **lista de equivalentes do Cross** (mais o campo de SKU livre, igual ao trocar-sku atual).

### 6.2 MVP2.1 — UI e troca no SISO

#### Onde aparece

Em `src/components/separacao/item-separacao-row.tsx`, novo botão/ícone (visual igual ao "trocar SKU" das telas de compras) em cada item ainda não bipado. Click abre dialog que reusa `equivalentes-list.tsx` do detalhe do Cross.

#### Fluxo do operador

1. Operador clica "Ver equivalentes" no item NETAIR-1234
2. Dialog abre com:
   - Lista de equivalentes do Cross (mesma lógica de `/cross/[sku]`)
   - Campo "Outro SKU" (input livre, igual ao trocar-sku atual de compras)
3. Operador clica em um equivalente OU digita SKU livre
4. Operador escolhe **motivo** num dropdown (lista padrão: `sem estoque físico`, `item danificado`, `cliente pediu equivalente`, `erro de cadastro`, `outro`)
5. Operador confirma (sem bipagem do código de barras — clique direto)
6. `POST /api/separacao/trocar-sku-item` faz a troca no SISO (sem Tiny)
7. UI atualiza: linha mostra novo SKU; toast confirma; histórico do pedido registra evento

#### Endpoint `POST /api/separacao/trocar-sku-item`

Body: `{ pedido_item_id: uuid, novo_sku: string, quantidade: int, motivo: text }`

- `quantidade` permite split: se for menor que `quantidade_pedida`, executa **substituição parcial** (atualiza qtd do item original e insere nova linha pra parte substituída)
- Reusa lógica do `trocar-sku` de compras (busca produto nas empresas do grupo, atualiza descrição/imagem/fornecedor/estoque)
- Insere registro em `siso_pedido_substituicoes`
- Registra evento em `siso_pedido_historico`
- Toast no SISO + entrada no histórico do pedido (sem notificação push)

#### Endpoint `POST /api/separacao/trocar-sku-item/desfazer`

Body: `{ substituicao_id }`

- Operador pode desfazer enquanto pedido **não foi expedido** (`status != 'expedido'`)
- Admin pode desfazer mesmo após expedição
- Reverte `siso_pedido_itens` para o estado anterior (joga nova linha fora se foi parcial; restaura SKU/descrição/etc se foi total)
- Atualiza `siso_pedido_substituicoes.desfeita_em`, `desfeita_por`

#### Permissões

| Ação | Cargos |
|---|---|
| Substituir | Operador do **galpão do pedido** + admin |
| Substituir por SKU **fora da lista de equivalentes** | Qualquer um (mantém paridade com `trocar-sku` de compras) |
| Desfazer (até expedição) | Operador que fez ou admin |
| Desfazer (após expedição) | Só admin |

### 6.3 MVP2.2 — Estoque Tiny (adiado, decisão fiscal)

A movimentação de estoque no Tiny (estorno do SKU original + baixa do SKU substituto) **não entra no MVP2.1**. Dois caminhos possíveis (decisão pendente):

| Caminho | O que faz | Implicação |
|---|---|---|
| **Via NF** | Cancela/emite NFs para refletir formalmente a troca | Fiscalmente limpo, operacionalmente complexo (regras SEFAZ, prazos) |
| **Ajuste direto** | Chama `/estoque/ajustar` no Tiny: +qty no original, −qty no substituto | Simples mas gera divergência entre NF (referência o SKU original) e estoque (mostra substituto) |

Até essa decisão acontecer, o time resolve a parte de Tiny/fiscal **manualmente** como já faz hoje (não há regressão — hoje também não tem essa automação). MVP2.1 já entrega valor: registra a substituição auditável no SISO.

### 6.4 Edge cases (MVP2.1)

| Caso | Tratamento |
|---|---|
| Substituto não existe no Tiny de nenhuma empresa do grupo | Bloqueia substituição (mesmo comportamento do trocar-sku atual) |
| Substituição parcial (qty 3, escolhe 2× do substituto) | Permitida: linha original fica com qty 1, nova linha com qty 2 do substituto |
| Tentar desfazer após expedição (operador) | 403 com mensagem "só admin pode desfazer após expedição" |
| Substituir SKU livre não cadastrado em nenhuma empresa | Bloqueia (igual `trocar-sku` atual) |

### 6.5 Tabela `siso_pedido_substituicoes` (MVP2.1)

```sql
CREATE TABLE siso_pedido_substituicoes (
  id                       bigserial PRIMARY KEY,
  pedido_id                uuid NOT NULL REFERENCES siso_pedidos(id),
  pedido_item_original_id  uuid NOT NULL,
  pedido_item_novo_id      uuid,                              -- pode ser NULL se split parcial
  sku_original             text NOT NULL,
  sku_substituto           text NOT NULL,
  quantidade               int NOT NULL,
  motivo                   text NOT NULL,
  fonte                    text NOT NULL CHECK (fonte IN ('equivalente_cross', 'sku_livre')),
  usuario_id               uuid NOT NULL REFERENCES siso_usuarios(id),
  criado_em                timestamptz NOT NULL DEFAULT now(),
  desfeita_em              timestamptz,
  desfeita_por             uuid REFERENCES siso_usuarios(id)
);
```

### 6.6 Pré-condições já atendidas pelo MVP1

- `GET /api/cross/produtos/:sku` devolve `equivalentes` com `estoque_por_galpao` (Seção 3.1)
- `siso_produto_oems` populado com qualidade razoável (Seção 5)
- Padrão `trocar-sku` em `src/app/api/compras/trocar-sku/route.ts` pode ser usado como base

Nenhuma alteração na UI do Cross é necessária para o MVP2.

---

## 7. Plano de fases

| Fase | Conteúdo | Dependências |
|---|---|---|
| **1.1 — Catálogo + busca read-only** | Tabelas, triggers, extração de OEM, seed do cross, `GET /search`, `GET /produtos/:sku`, página `/cross`, página `/cross/[sku]` sem edição | `pg_trgm` habilitado |
| **1.2 — Edição de OEMs** | Endpoints `POST/DELETE /oems`, componente `oem-list-editor.tsx`, regras de permissão (admin remove qualquer um), aviso de cruzamento | 1.1 |
| **1.3 — Edição de veículos** | Endpoints `POST/DELETE /veiculos`, `GET /sugestoes/*`, componente `veiculo-list-editor.tsx` | 1.2 |
| **1.4 — Refresh manual + telemetria** | Botão "Atualizar agora" (sem TTL), tratamento de Tiny offline, `siso_cross_logs` (com `usuario_id`) | 1.1 |
| **2.1 — Substituição na separação (UI + SISO)** | `siso_pedido_substituicoes`, `POST /api/separacao/trocar-sku-item` (espelho do `compras/trocar-sku`), `POST .../desfazer`, dialog com lista do Cross + SKU livre, motivo via dropdown | 1.4 estabilizado |
| **2.2 — Estoque Tiny (estorno + baixa)** | Decisão fiscal pendente (NF formal vs ajuste direto). Não planejado ainda. | 2.1 + decisão de negócio |

Cada fase é entregável independente, deployável separadamente.

---

## 8. Documentação a atualizar (no mesmo PR de cada fase)

| Documento | O quê |
|---|---|
| `docs/api-reference-complete.md` | Todas as rotas `/api/cross/*` (e `/api/separacao/substituir-item` no MVP2) |
| `docs/database-schema.md` | Tabelas `siso_produtos_catalogo`, `siso_produto_oems`, `siso_produto_veiculos`, `siso_cross_logs` (+ `siso_pedido_substituicoes` no MVP2) |
| `docs/architecture-and-flows.md` | Seção nova "Cross: catálogo e equivalência" + fluxo de substituição (MVP2) |
| `docs/fluxos-siso.md` | Mermaid do fluxo lazy + TTL + (MVP2) substituição |
| `CLAUDE.md` | Adicionar rotas de página, API e libs em "Project Structure" |
| `erros-conhecidos.yaml` | Conforme bugs forem fixados |

---

## 9. Decisões registradas

### Arquitetura e dados
| Tema | Decisão | Justificativa |
|---|---|---|
| Acoplamento com cross | Independente — código portado para SISO | Usuário quer descontinuar o cross |
| Fonte de dados de equivalência | OEM (não compatibilidade veicular) | OEM define equivalência funcional; veículos servem só para confirmação visual |
| Modelo de dados de OEM | Relacional (`siso_produto_oems`) com array desnormalizado para query | Audit por usuário + busca rápida |
| Modelo de dados de veículos | Relacional (`siso_produto_veiculos`) + JSONB derivado | UX de CRUD + retro-compatibilidade |
| Catálogo de marcas/modelos | Texto livre + autocomplete dinâmico | Evita projeto paralelo de catálogo |
| Nome do módulo | "Cross" | Mantém referência ao projeto de origem |

### População e atualização
| Tema | Decisão | Justificativa |
|---|---|---|
| Lançamento | Seed inicial **importando tudo** do projeto Cross atual | Operador já enxerga catálogo cheio no dia 1 |
| Sync recorrente | **Não implementar** (sem TTL automático) | Reduz complexidade; uso real puxa o que precisa |
| Refresh do Tiny | **Apenas sob demanda** via botão "Atualizar agora" | Operador controla quando precisa de dado fresco |
| Tiny offline | Mensagem clara `"Tiny indisponível, tente em alguns minutos"`, sem retry agressivo | Operador entende que é problema externo |
| Refetch e dados manuais | Refetch nunca **remove** OEM/veículo existente | Preserva trabalho do operador |

### Permissões e auditoria
| Tema | Decisão | Justificativa |
|---|---|---|
| Quem acessa o Cross | Todos logados (admin + operadores + comprador) | Caso de uso é universal |
| Quem cadastra OEM/veículo | Todos que acessam | Operador na ponta cadastra na hora que descobre |
| Quem remove OEM/veículo de **outros** | **Só admin** (cada um remove o que cadastrou) | Evita guerra de cadastros, mantém auditoria |
| Filtro por galpão na busca | Sem filtro | Caso de uso é justamente cross-galpão |
| Auditoria de buscas | Tabela `siso_cross_logs` **com identificação do usuário** | Permite análise de uso e produtos mais buscados |
| Aviso de cruzamento de OEM | Mostra toast quando OEM cadastrado já existe em outro SKU | Operador percebe equivalência valiosa criada |

### Substituição na separação (MVP2.1)
| Tema | Decisão | Justificativa |
|---|---|---|
| Quem substitui | Operador do **galpão do pedido** + admin | Quem está no chão resolve; isolamento entre galpões |
| Substituição parcial | **Permitida** (split em duas linhas) | Realismo: melhor mandar 2 do que 0 |
| Motivo | **Obrigatório**, dropdown padronizado | Permite estatística depois ('por que tantas substituições') |
| Notificação | Toast no SISO + entrada no histórico do pedido | Sem spam de notificação push |
| Bipagem do substituto | **Não bipar**, clique direto na tela | Mesma UX do `trocar-sku` atual em compras |
| Substituto fora da lista de equivalentes | **Permitido** para qualquer cargo | Mantém paridade com `trocar-sku` atual |
| Desfazer substituição | Operador desfaz **enquanto pedido não foi expedido**; admin desfaz sempre | Janela de correção sem chamar admin |
| Reuso de código | MVP2.1 espelha `src/app/api/compras/trocar-sku/route.ts` | Padrão já validado no SISO |

### Estoque Tiny / fiscal (MVP2.2)
| Tema | Decisão | Justificativa |
|---|---|---|
| Estorno + baixa no Tiny | **Adiado** — decisão fiscal pendente entre via NF (formal) ou ajuste direto | Tem implicação fiscal real; o time vê depois |
| Comportamento até a decisão | Substituição registra no SISO sem tocar Tiny | Sem regressão (hoje também não automatiza); MVP2.1 já entrega valor |
