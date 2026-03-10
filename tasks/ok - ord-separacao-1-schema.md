# PRD 1/7 — Separação: Schema + Dados Base

**Depende de:** Nada
**Bloqueia:** PRD 3 (NF Webhook), PRD 4 (API Separação)

---

## 1. Introdução

Este PRD cobre as migrations de banco de dados e alterações mínimas no webhook-processor e endpoint de aprovação para que os dados de separação sejam persistidos corretamente. Nenhuma tela nova é criada — o objetivo é que pedidos novos passem a ter os campos de separação preenchidos.

### Problema que resolve

- Não existe coluna para rastrear status de separação, galpão de separação, GTIN, ou progresso de bip
- webhook-processor não salva localização normalizada por empresa nem GTIN
- Endpoint de aprovação não recalcula galpão de separação quando decisão muda

---

## 2. Goals

- Todas as colunas e índices de separação existem no banco
- Função PL/pgSQL `siso_processar_bip` criada (usada pelo PRD 4)
- Pedidos novos processados pelo webhook-processor têm `separacao_galpao_id`, `status_separacao`, GTIN e localização normalizada preenchidos
- Endpoint de aprovação recalcula `separacao_galpao_id` quando decisão final difere da sugestão

---

## 3. User Stories

### US-006: Captura de GTIN no webhook processor

**Description:** Como sistema, preciso salvar o GTIN (código de barras EAN) de cada produto ao processar o webhook, para que o leitor de código de barras funcione na separação.

**Acceptance Criteria:**
- [ ] `webhook-processor.ts`: ao buscar detalhes do produto (`getProdutoDetalhe`), também captura o campo `gtin` — campo confirmado na spec Tiny v3 (`ObterProdutoModelResponse.gtin: string | null`)
- [ ] GTIN capturado na PRIMEIRA chamada de `getProdutoDetalhe` (que já ocorre para detectar kit), evitando chamada API adicional
- [ ] GTIN salvo em nova coluna `gtin` na tabela `siso_pedido_itens`
- [ ] `tiny-api.ts`: interface `TinyProdutoDetalhe` inclui `gtin: string | null`
- [ ] Para produtos de empresas suporte (busca por SKU), também captura GTIN
- [ ] Pedidos já existentes (sem GTIN) continuam funcionando — scan por SKU como fallback
- [ ] Typecheck/lint passes

---

### US-009: Determinação do galpão de separação

**Description:** Como sistema, preciso determinar em qual galpão cada pedido será fisicamente separado, para mostrá-lo na tela correta.

**Acceptance Criteria:**
- [ ] Campo `separacao_galpao_id` em `siso_pedidos` (FK → siso_galpoes)
- [ ] Preenchido automaticamente no webhook-processor com base na **sugestão**:
  - `propria` → galpão da empresa de origem
  - `transferencia` → galpão da empresa suporte (onde o estoque está)
  - `oc` → galpão da empresa de origem (mesmo sem estoque, o pedido será despachado de lá)
- [ ] **CRÍTICO:** Ao aprovar pedido (`POST /api/pedidos/aprovar`), se a `decisao_final` diferir da `sugestao`, RECALCULAR e atualizar `separacao_galpao_id` de acordo. Exemplo: sugestão era `transferencia` (galpão CWB), operador aprova como `propria` → atualizar para galpão SP
- [ ] Pedidos OC ficam com `separacao_galpao_id` do galpão de origem
- [ ] Typecheck/lint passes

---

### US-010: Status de separação independente

**Description:** Como sistema, preciso rastrear o progresso da separação física independente do status de processamento (NF/estoque).

**Acceptance Criteria:**
- [ ] Nova coluna `status_separacao` em `siso_pedidos` com valores: `'aguardando_nf'`, `'pendente'`, `'em_separacao'`, `'embalado'`, `'expedido'`, `'cancelado'`
- [ ] Default: `'aguardando_nf'` (preenchido no webhook-processor para pedidos aprovados/auto-aprovados)
- [ ] Pedidos existentes (anteriores ao módulo) ficam com `status_separacao = NULL` — filtrados com `WHERE status_separacao IS NOT NULL` nas queries de separação
- [ ] Transições (referência — enforcement nos PRDs posteriores):
  - `aguardando_nf → pendente` (NF autorizada via webhook — PRD 3)
  - `pendente → em_separacao` (primeiro item bipado — PRD 4)
  - `em_separacao → embalado` (todos itens bipados — PRD 4)
  - `embalado → expedido` (marcação manual — PRD 5)
  - `* → cancelado` (webhook de cancelamento)
- [ ] `status_separacao` é independente de `status` (NF/estoque) — podem progredir em paralelo
- [ ] Colunas auxiliares: `separado_por` (UUID), `separado_em` (timestamp), `embalado_em` (timestamp)
- [ ] Colunas de NF: `url_danfe` (text), `chave_acesso_nf` (text) — preenchidos pelo webhook de NF (PRD 3)
- [ ] Coluna `etiqueta_status` (text): `'pendente'`, `'imprimindo'`, `'impresso'`, `'falhou'`
- [ ] Coluna `agrupamento_tiny_id` (bigint) — preenchido pelo PRD 7
- [ ] Coluna `etiqueta_url` (text) — preenchido pelo PRD 7
- [ ] Webhook de cancelamento existente deve setar `status_separacao = 'cancelado'` além de `status = 'cancelado'`
- [ ] Typecheck/lint passes

---

### US-011: Rastreio de bips por item (colunas apenas)

**Description:** Como sistema, preciso das colunas para rastrear quais itens foram bipados em cada pedido.

**Acceptance Criteria:**
- [ ] Novas colunas em `siso_pedido_itens`:
  - `gtin` (text) — EAN do produto
  - `quantidade_bipada` (integer, default 0)
  - `bipado_completo` (boolean, default false)
  - `bipado_em` (timestamptz)
  - `bipado_por` (uuid FK → siso_usuarios)
- [ ] Nova coluna em `siso_pedido_item_estoques`:
  - `localizacao` (text) — localização do produto naquela empresa/depósito
- [ ] Typecheck/lint passes

---

## 4. Functional Requirements

- FR-1: Migration adiciona todas as colunas de separação em `siso_pedidos` (conforme schema abaixo)
- FR-2: Migration adiciona colunas de bip em `siso_pedido_itens` (conforme schema abaixo)
- FR-3: Migration adiciona `localizacao` em `siso_pedido_item_estoques`
- FR-4: Migration cria índices para queries de separação (conforme schema abaixo)
- FR-5: Migration cria função PL/pgSQL `siso_processar_bip` (usada pelo PRD 4)
- FR-6: GTIN de cada produto capturado no webhook-processor e salvo em `siso_pedido_itens.gtin`
- FR-7: `localizacao` salva em `siso_pedido_item_estoques` durante enrichment (já disponível em `estoquesPorEmpresa`)
- FR-8: `separacao_galpao_id` calculado no webhook-processor com base na sugestão
- FR-9: `status_separacao = 'aguardando_nf'` definido para pedidos aprovados/auto-aprovados
- FR-10: Endpoint de aprovação recalcula `separacao_galpao_id` se `decisao_final != sugestao`
- FR-11: Webhook de cancelamento seta `status_separacao = 'cancelado'`

---

## 5. Non-Goals

- **Não** criar API routes de separação (PRD 4)
- **Não** criar tela de separação (PRD 5)
- **Não** implementar handler de NF webhook (PRD 3)
- **Não** fazer backfill de pedidos antigos

---

## 6. Technical Considerations

### 6.1 Migration SQL

```sql
-- Migration: 20260311_add_separacao_columns.sql

-- siso_pedidos: separation tracking
ALTER TABLE siso_pedidos
  ADD COLUMN status_separacao text DEFAULT NULL
    CHECK (status_separacao IS NULL OR status_separacao IN ('aguardando_nf', 'pendente', 'em_separacao', 'embalado', 'expedido', 'cancelado')),
  ADD COLUMN separacao_galpao_id uuid REFERENCES siso_galpoes(id),
  ADD COLUMN separado_por uuid REFERENCES siso_usuarios(id),
  ADD COLUMN separado_em timestamptz,
  ADD COLUMN embalado_em timestamptz,
  ADD COLUMN agrupamento_tiny_id bigint,
  ADD COLUMN etiqueta_url text,
  ADD COLUMN etiqueta_status text DEFAULT NULL
    CHECK (etiqueta_status IS NULL OR etiqueta_status IN ('pendente', 'imprimindo', 'impresso', 'falhou')),
  ADD COLUMN url_danfe text,
  ADD COLUMN chave_acesso_nf text;

-- siso_pedido_itens: bip tracking + GTIN
ALTER TABLE siso_pedido_itens
  ADD COLUMN gtin text,
  ADD COLUMN quantidade_bipada integer DEFAULT 0,
  ADD COLUMN bipado_completo boolean DEFAULT false,
  ADD COLUMN bipado_em timestamptz,
  ADD COLUMN bipado_por uuid REFERENCES siso_usuarios(id);

-- siso_pedido_item_estoques: localizacao normalizada
ALTER TABLE siso_pedido_item_estoques
  ADD COLUMN localizacao text;

-- Indexes for separation queries
CREATE INDEX idx_pedidos_separacao_galpao
  ON siso_pedidos (separacao_galpao_id, status_separacao)
  WHERE status_separacao IN ('pendente', 'em_separacao');

CREATE INDEX idx_pedidos_separacao_aguardando
  ON siso_pedidos (separacao_galpao_id)
  WHERE status_separacao = 'aguardando_nf';

CREATE INDEX idx_pedidos_separacao_embalado
  ON siso_pedidos (separacao_galpao_id)
  WHERE status_separacao = 'embalado';

CREATE INDEX idx_pedido_itens_gtin ON siso_pedido_itens (gtin)
  WHERE gtin IS NOT NULL AND bipado_completo = false;

CREATE INDEX idx_pedido_itens_sku ON siso_pedido_itens (sku)
  WHERE bipado_completo = false;

CREATE INDEX idx_pedidos_separacao_data
  ON siso_pedidos (separacao_galpao_id, data ASC)
  WHERE status_separacao IN ('pendente', 'em_separacao');
```

### 6.2 Função PL/pgSQL: siso_processar_bip

```sql
CREATE OR REPLACE FUNCTION siso_processar_bip(
  p_codigo text,
  p_usuario_id uuid,
  p_galpao_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_item RECORD;
  v_pedido RECORD;
  v_itens_faltam integer;
BEGIN
  -- 1. Find and lock the oldest pending item atomically
  SELECT pi.pedido_id, pi.produto_id, pi.quantidade_bipada, pi.quantidade_pedida,
         pi.sku, p.numero AS pedido_numero, p.status_separacao
  INTO v_item
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE (pi.gtin = p_codigo OR pi.sku = p_codigo)
    AND pi.bipado_completo = false
    AND p.separacao_galpao_id = p_galpao_id
    AND p.status_separacao IN ('pendente', 'em_separacao')
    AND p.status != 'cancelado'
  ORDER BY p.data ASC
  LIMIT 1
  FOR UPDATE OF pi SKIP LOCKED;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('status', 'nao_encontrado', 'codigo', p_codigo);
  END IF;

  -- 2. Safety check
  IF v_item.quantidade_bipada >= v_item.quantidade_pedida THEN
    RETURN jsonb_build_object('status', 'ja_completo', 'pedido_id', v_item.pedido_id, 'sku', v_item.sku);
  END IF;

  -- 3. Increment bip
  UPDATE siso_pedido_itens SET
    quantidade_bipada = quantidade_bipada + 1,
    bipado_por = p_usuario_id,
    bipado_completo = (quantidade_bipada + 1 >= quantidade_pedida),
    bipado_em = CASE WHEN (quantidade_bipada + 1 >= quantidade_pedida) THEN now() ELSE bipado_em END
  WHERE pedido_id = v_item.pedido_id AND produto_id = v_item.produto_id;

  -- 4. Transition pendente → em_separacao on first bip
  IF v_item.status_separacao = 'pendente' THEN
    UPDATE siso_pedidos SET
      status_separacao = 'em_separacao',
      separado_por = p_usuario_id,
      separado_em = now()
    WHERE id = v_item.pedido_id AND status_separacao = 'pendente';
  END IF;

  -- 5. Check if all items are complete
  SELECT COUNT(*) FILTER (WHERE bipado_completo = false) INTO v_itens_faltam
  FROM siso_pedido_itens WHERE pedido_id = v_item.pedido_id;

  IF v_itens_faltam = 0 THEN
    UPDATE siso_pedidos SET
      status_separacao = 'embalado',
      embalado_em = now(),
      etiqueta_status = 'pendente'
    WHERE id = v_item.pedido_id;

    RETURN jsonb_build_object(
      'status', 'pedido_completo',
      'pedido_id', v_item.pedido_id,
      'pedido_numero', v_item.pedido_numero,
      'sku', v_item.sku,
      'bipados', v_item.quantidade_bipada + 1,
      'total', v_item.quantidade_pedida
    );
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN (v_item.quantidade_bipada + 1 >= v_item.quantidade_pedida) THEN 'item_completo' ELSE 'parcial' END,
    'pedido_id', v_item.pedido_id,
    'pedido_numero', v_item.pedido_numero,
    'sku', v_item.sku,
    'bipados', v_item.quantidade_bipada + 1,
    'total', v_item.quantidade_pedida,
    'itens_faltam', v_itens_faltam
  );
END;
$$ LANGUAGE plpgsql;
```

### 6.3 Alterações no webhook-processor.ts

1. **GTIN:** Na chamada existente de `getProdutoDetalhe` (já feita para detectar kit), capturar `gtin` e incluir no upsert de `siso_pedido_itens`
2. **Localização:** No enrichment de estoque por empresa, salvar `localizacao` em `siso_pedido_item_estoques` (já disponível nos dados de estoque)
3. **separacao_galpao_id:** Ao salvar o pedido, calcular:
   - `propria` ou `oc` → `empresaOrigem.galpao_id`
   - `transferencia` → galpão da empresa que tem estoque (empresa suporte)
4. **status_separacao:** Setar `'aguardando_nf'` para pedidos aprovados/auto-aprovados

### 6.4 Alterações no POST /api/pedidos/aprovar

Ao update do pedido, se `decisao_final != sugestao`:
- `propria` ou `oc` → `separacao_galpao_id = empresaOrigem.galpao_id`
- `transferencia` → `separacao_galpao_id = empresaSuporte.galpao_id` (já resolvido no endpoint como `empresaExecucaoId`)

### 6.5 Alteração no webhook de cancelamento

Se pedido tem `status_separacao IS NOT NULL`, setar `status_separacao = 'cancelado'` junto com `status = 'cancelado'`.

---

## 7. Validação

Após implementação, verificar via SQL:
```sql
-- 1. Colunas existem
SELECT column_name FROM information_schema.columns
WHERE table_name = 'siso_pedidos' AND column_name IN ('status_separacao', 'separacao_galpao_id', 'etiqueta_status');

-- 2. Função existe
SELECT proname FROM pg_proc WHERE proname = 'siso_processar_bip';

-- 3. Índices existem
SELECT indexname FROM pg_indexes WHERE tablename = 'siso_pedidos' AND indexname LIKE '%separacao%';

-- 4. Processar um pedido novo e verificar campos preenchidos
SELECT id, status_separacao, separacao_galpao_id FROM siso_pedidos ORDER BY criado_em DESC LIMIT 1;
```

---

## 8. Success Metrics

- Todas as migrations rodam sem erro
- Pedidos novos têm `status_separacao = 'aguardando_nf'` e `separacao_galpao_id` preenchidos
- GTIN capturado para produtos que têm no Tiny
- Localização salva em `siso_pedido_item_estoques`
- Zero regressão no fluxo existente (dashboard, aprovação, worker)
