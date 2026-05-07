# WMS — Design do Sistema de Estoque Interno do SISO

**Data:** 2026-05-07
**Status:** Spec aprovado — pendente revisão final do user
**Substitui:** plano em `docs/wms/` (descartado em 2026-05-07)

---

## 1. Resumo executivo

O SISO hoje delega controle de estoque ao Tiny ERP: a cada webhook de pedido, faz `getEstoque()` no Tiny pra cada item de cada empresa do grupo (~3000+ chamadas/dia). Sem ledger local, sem catálogo unificado, sem rastro de empréstimos inter-empresa, sem reservas atômicas. Tiny é fonte da verdade.

Esse spec define uma reescrita do controle de estoque pra dentro do SISO: **ledger imutável append-only** como fonte da verdade, com cache materializado de saldo, registro formal de empréstimos entre empresas, regras configuráveis de compartilhamento e roteamento de pedidos com prioridade geográfica. Tiny vira ferramenta fiscal (NF, marcadores, cadastros) e seu saldo deixa de importar pra contabilidade.

A migração é em **5 fases**, começando com módulo standalone que não toca o fluxo crítico atual.

## 2. Princípios fundamentais (decisões travadas com user)

1. **SISO mestre absoluto.** Toda movimentação de estoque nasce e vive no SISO. Tiny vira ferramenta fiscal.
2. **Estoque tem 3 marcações:** produto, dono fiscal (quem pagou), galpão físico (onde está). Mesma SKU pode ter N donos com saldos independentes.
3. **Ledger imutável append-only** é a fonte da verdade. `siso_estoque` é cache materializado, reconstruível a partir do ledger.
4. **Empréstimos como tracker puro.** Quitam por fluxo reverso (NetParts deve à NetAir; quita quando NetAir vendeu usando estoque da NetParts).
5. **Sharing rules em matriz N×N direcional** (empresa credora → empresa devedora, configurável por par).
6. **Prioridade de roteamento geográfica:** próprio antes de empréstimo; depois galpão > cidade > estado > qualquer; empate por maior saldo disponível.
7. **Reservas atômicas com lock pessimista** pra prevenir oversell entre aprovação e NF.
8. **Entradas de estoque manuais em v1.** Operador registra recebimento via tela. Auto-import via NF de entrada fica pra v2+.
9. **Devoluções classificadas pelo operador** na chegada (íntegra, avariada).
10. **Marketplace sync deferido pra v2.** Tiny saldo vai divergir; aceita.
11. **Migração com isolamento total na Fase 0** (módulo standalone). Sem impacto no fluxo crítico atual até que toda funcionalidade isolada seja validada.

## 3. Schema completo

### 3.1 Catálogo unificado

```sql
CREATE TABLE siso_produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  descricao text NOT NULL,
  gtin text,
  imagem_url text,
  unidade text NOT NULL DEFAULT 'UN',
  ncm text,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_produtos_sku ON siso_produtos(sku);
CREATE INDEX idx_produtos_gtin ON siso_produtos(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_produtos_ativo ON siso_produtos(ativo) WHERE ativo = true;
```

### 3.2 Mapeamento SKU ↔ Tiny por empresa

```sql
CREATE TABLE siso_produto_empresas (
  produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id) ON DELETE CASCADE,
  tiny_produto_id bigint NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  PRIMARY KEY (produto_id, empresa_id),
  UNIQUE(empresa_id, tiny_produto_id)
);

CREATE INDEX idx_prod_emp_tiny ON siso_produto_empresas(empresa_id, tiny_produto_id);
```

### 3.3 Galpões (extensão do existente com geolocalização)

```sql
ALTER TABLE siso_galpoes
  ADD COLUMN cidade text,
  ADD COLUMN estado text CHECK (estado IS NULL OR estado ~ '^[A-Z]{2}$'),
  ADD COLUMN pais text NOT NULL DEFAULT 'BR';
```

### 3.4 Estoque (cache materializado da posição atual)

```sql
CREATE TABLE siso_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  saldo numeric NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  reservado numeric NOT NULL DEFAULT 0 CHECK (reservado >= 0),
  disponivel numeric GENERATED ALWAYS AS (saldo - reservado) STORED,
  custo_medio numeric(12,4) NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_id, empresa_dona_id, galpao_id),
  CHECK (reservado <= saldo)
);

CREATE INDEX idx_estoque_dono ON siso_estoque(empresa_dona_id, produto_id);
CREATE INDEX idx_estoque_galpao ON siso_estoque(galpao_id, produto_id);
CREATE INDEX idx_estoque_disponivel ON siso_estoque(produto_id) WHERE disponivel > 0;
```

**Constraint `reservado <= saldo`:** invariante que impede reservar mais do que tem.

### 3.5 Ledger de movimentações (CORE)

```sql
CREATE TABLE siso_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- O que se move (mesma tripla do estoque)
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),

  -- Tipo mecânico
  tipo char(1) NOT NULL CHECK (tipo IN ('E','S','R','L')),
  quantidade numeric NOT NULL CHECK (quantidade > 0),

  -- Chain verificável (saldo anterior/posterior + reservado anterior/posterior)
  saldo_anterior numeric NOT NULL CHECK (saldo_anterior >= 0),
  saldo_posterior numeric NOT NULL CHECK (saldo_posterior >= 0),
  reservado_anterior numeric NOT NULL CHECK (reservado_anterior >= 0),
  reservado_posterior numeric NOT NULL CHECK (reservado_posterior >= 0),

  -- Origem de negócio
  origem_tipo text NOT NULL CHECK (origem_tipo IN (
    'compra_manual',
    'nf_venda',
    'nf_devolucao_cliente',
    'nf_devolucao_avariada',
    'nf_devolucao_fornecedor',
    'transferencia',
    'emprestimo',
    'reserva_pedido',
    'liberacao_reserva',
    'ajuste_manual',
    'inventario',
    'inventario_inicial',
    'estorno',
    'cancelamento_nf'
  )),
  origem_id text,
  origem_detalhes jsonb NOT NULL DEFAULT '{}',

  -- Empréstimo (preenchido só quando origem_tipo='emprestimo')
  emprestimo_devedora_id uuid REFERENCES siso_empresas(id),

  -- Fiscal
  nota_fiscal_id bigint,
  chave_acesso_nf text,
  custo_unitario numeric(12,4),

  -- Audit
  usuario_id uuid REFERENCES siso_usuarios(id),
  observacoes text,
  estorno_de uuid REFERENCES siso_movimentacoes(id),

  criado_em timestamptz NOT NULL DEFAULT now(),

  -- Validações de consistência
  CHECK (
    (origem_tipo = 'emprestimo' AND emprestimo_devedora_id IS NOT NULL)
    OR (origem_tipo <> 'emprestimo' AND emprestimo_devedora_id IS NULL)
  ),
  CHECK (
    (tipo = 'E' AND saldo_posterior = saldo_anterior + quantidade)
    OR (tipo = 'S' AND saldo_posterior = saldo_anterior - quantidade)
    OR (tipo IN ('R','L') AND saldo_posterior = saldo_anterior)
  ),
  CHECK (
    (tipo = 'R' AND reservado_posterior = reservado_anterior + quantidade)
    OR (tipo = 'L' AND reservado_posterior = reservado_anterior - quantidade)
    OR (tipo IN ('E','S') AND reservado_posterior = reservado_anterior)
  )
);

CREATE INDEX idx_mov_produto ON siso_movimentacoes(produto_id, criado_em DESC);
CREATE INDEX idx_mov_dona ON siso_movimentacoes(empresa_dona_id, criado_em DESC);
CREATE INDEX idx_mov_galpao ON siso_movimentacoes(galpao_id, criado_em DESC);
CREATE INDEX idx_mov_origem ON siso_movimentacoes(origem_tipo, origem_id);
CREATE INDEX idx_mov_nf ON siso_movimentacoes(nota_fiscal_id) WHERE nota_fiscal_id IS NOT NULL;
CREATE INDEX idx_mov_estorno ON siso_movimentacoes(estorno_de) WHERE estorno_de IS NOT NULL;
CREATE INDEX idx_mov_emprestimo
  ON siso_movimentacoes(empresa_dona_id, emprestimo_devedora_id, criado_em DESC)
  WHERE origem_tipo = 'emprestimo';
```

**Validações via CHECK:** garantem que `saldo_posterior` reflete corretamente o `tipo` e `quantidade`. Impossível inserir linha incoerente.

### 3.6 Regras de empréstimo (matriz N×N direcional)

```sql
CREATE TABLE siso_emprestimo_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_credora_id uuid NOT NULL REFERENCES siso_empresas(id),
  empresa_devedora_id uuid NOT NULL REFERENCES siso_empresas(id),
  ativo boolean NOT NULL DEFAULT true,
  limite_max_por_produto numeric,
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_credora_id, empresa_devedora_id),
  CHECK (empresa_credora_id <> empresa_devedora_id)
);

CREATE INDEX idx_regra_devedora ON siso_emprestimo_regras(empresa_devedora_id) WHERE ativo;
CREATE INDEX idx_regra_credora ON siso_emprestimo_regras(empresa_credora_id) WHERE ativo;
```

### 3.7 Diagrama ER

```
siso_produtos ──┬── siso_produto_empresas ── siso_empresas ──┬── siso_galpoes
                │                                              │
                ├── siso_estoque ─────────────────────────────┤
                │                                              │
                ├── siso_movimentacoes ───────────────────────┤
                │                                              │
                └── (consultas derivadas: saldo devedor, etc)  │
                                                                │
siso_emprestimo_regras (credora_id, devedora_id) ──────────────┘
```

## 4. Tipos de movimentação (origem_tipo)

| origem_tipo | Tipo | Disparado por | Observações |
|---|---|---|---|
| `inventario_inicial` | E | Job de migração | Snapshot fundacional na Fase 0 |
| `compra_manual` | E | Operador | Tela "Receber estoque" |
| `nf_venda` | S | Webhook NF venda | Vendedora = dona |
| `emprestimo` | S | Webhook NF venda | Vendedora ≠ dona; preenche `emprestimo_devedora_id` |
| `nf_devolucao_cliente` | E | Operador classifica | Volta pra dona original (quita empréstimo se aplicável) |
| `nf_devolucao_avariada` | E + S | Operador classifica | Par atômico: entra fiscalmente + sai por avaria |
| `nf_devolucao_fornecedor` | S | Operador | RMA pra fornecedor |
| `transferencia` | S + E | Operador | Par atômico entre galpões da mesma empresa |
| `reserva_pedido` | R | Aprovação de pedido | Lock pessimista |
| `liberacao_reserva` | L | NF emitida ou cancelamento | Em par com S quando NF, ou solo quando cancelamento |
| `ajuste_manual` | E ou S | Operador | Motivo obrigatório (avaria, perda, encontro, etc) |
| `inventario` | E ou S | Sessão de inventário | Lote por divergência |
| `estorno` | inverso | Admin | `estorno_de` aponta pra mov original |
| `cancelamento_nf` | inverso de S | Webhook cancelamento | Auto-disparado quando Tiny notifica cancelamento de NF |

## 5. Fluxos críticos

### 5.1 Entrada manual de estoque (compra recebida)

```
Operador recebe mercadoria fisicamente.
→ Abre tela "Receber estoque" no SISO.
→ Preenche: empresa dona, galpão de destino, item por item (SKU/qty/custo).
→ Opcional: NF número e PDF anexo (referência fiscal).
→ Confirma.

Sistema, em transação atômica por item:
  - Resolve produto via SKU (cria no catálogo se novo).
  - Insere mov tipo='E' origem='compra_manual'.
  - UPDATE siso_estoque (produto, dona, galpão): saldo += qty.
  - Recalcula custo_medio (média ponderada com saldo anterior).
```

Nada toca o Tiny.

### 5.2 Venda própria (vendedora = dona do estoque)

```
Webhook pedido → identifica empresa V vendedora.

Roteamento:
  candidatos = SELECT * FROM siso_estoque
    WHERE produto_id = X
      AND empresa_dona_id = V
      AND disponivel >= qty
    ORDER BY (geo distance to V.home_galpao), disponivel DESC
    LIMIT 1
  Se encontrou: VENDA PRÓPRIA, deduz dessa linha.

Reserva atômica:
  BEGIN;
    SELECT * FROM siso_estoque WHERE (...) FOR UPDATE;
    INSERT mov tipo='R' origem='reserva_pedido';
    UPDATE siso_estoque SET reservado = reservado + qty;
  COMMIT;

Worker → Tiny: gera NF de venda na empresa V.

Webhook NF autorizada chega:
  BEGIN;
    INSERT mov tipo='S' origem='nf_venda', nota_fiscal_id;
    INSERT mov tipo='L' origem='liberacao_reserva';
    UPDATE siso_estoque SET saldo -= qty, reservado -= qty;
  COMMIT;
```

### 5.3 Venda com empréstimo (vendedora ≠ dona)

```
Webhook pedido → identifica empresa V vendedora.

Roteamento (V não tem próprio):
  credoras = SELECT empresa_credora_id FROM siso_emprestimo_regras
    WHERE empresa_devedora_id = V AND ativo;

  candidatos = SELECT * FROM siso_estoque e JOIN siso_galpoes g
    WHERE produto_id = X
      AND empresa_dona_id IN (credoras)
      AND e.disponivel >= qty
    ORDER BY (geo distance to V.home_galpao), e.disponivel DESC
    LIMIT 1
  Se encontrou: EMPRÉSTIMO C → V, deduz dessa linha.

Reserva atômica em (X, C, galpão_C):
  - mov tipo='R' origem='reserva_pedido'

Worker → Tiny: gera NF de venda na empresa V (não em C).

Webhook NF autorizada:
  - mov tipo='S' origem='emprestimo' (na tripla X, C, galpão_C)
    com emprestimo_devedora_id = V
  - mov tipo='L' origem='liberacao_reserva'
  - UPDATE siso_estoque (X, C, galpão_C): saldo -= qty, reservado -= qty
```

**Resultado:** NetParts (V) deve `qty` unidades a NetAir (C). Saldo de NetAir cai em SC. Saldo de NetParts inalterado no SISO.

**Tiny:** NF emitida pela NetParts; saldo Tiny da NetParts vai pra negativo (ok, fictício). Saldo Tiny da NetAir não muda (NF não é dela).

### 5.4 Devolução de cliente

Quando NF de devolução chega via webhook, **não é processada automaticamente**. Vai pra fila "Devoluções pendentes":

```
NF devolução webhook → INSERT siso_devolucoes_pendentes (status='aguardando_classificacao')
                       (NF vinculada, pedido original identificado, mercadoria ainda não chegou)
```

Quando mercadoria chega fisicamente, operador abre fila e classifica:

#### Classificação A — Íntegro

```
Sistema identifica: pedido original era "venda própria" ou "empréstimo".
- Se própria: dona da entrada = empresa vendedora.
- Se empréstimo: dona da entrada = empresa credora original (auto-quita 1 unidade do empréstimo).

INSERT mov tipo='E' origem='nf_devolucao_cliente'
  na tripla (produto, dona, galpão_de_recebimento)
UPDATE siso_estoque: saldo += qty
```

#### Classificação B — Avariado

```
Mesma resolução de dona (A vai pra dona original, B vai pra credora original).

Em transação atômica:
  INSERT mov tipo='E' origem='nf_devolucao_avariada' (volta fiscalmente)
  INSERT mov tipo='S' origem='ajuste_manual' (sai por avaria, motivo='retorno_quebrado')
  UPDATE siso_estoque: net 0 mas duas linhas no ledger.
```

#### Classificação C — Outras situações (a discutir caso a caso)

Garantia, troca por outro SKU, etc. Modelados como ajustes manuais com observação.

### 5.5 Transferência intra-empresa

```
Operador abre "Transferir entre galpões" no SISO.
Escolhe empresa (NetAir), galpão origem (CWB), galpão destino (SC), itens, qty.
Confirma.

Em transação atômica:
  INSERT mov tipo='S' origem='transferencia' em (produto, NetAir, CWB)
  INSERT mov tipo='E' origem='transferencia' em (produto, NetAir, SC)
  Mesmo origem_id (sessão de transferência).
  UPDATE ambas linhas de siso_estoque.
```

Sem NF. Sem Tiny.

### 5.6 Cancelamento de pedido

**Antes da NF:** apenas libera reserva.

```
INSERT mov tipo='L' origem='liberacao_reserva'
UPDATE siso_estoque: reservado -= qty
```

**Depois da NF:** opera via NF de devolução (fluxo 5.4) ou via cancelamento de NF no Tiny (fluxo 5.7).

### 5.7 Cancelamento de NF (webhook do Tiny)

```
Webhook cancelamento_nf chega.
Sistema identifica mov de saída original via nota_fiscal_id.

INSERT mov tipo='E' origem='cancelamento_nf' (inversa da saída)
  estorno_de = id da mov original
UPDATE siso_estoque: saldo += qty

Se a mov original era 'emprestimo': empréstimo é desfeito automaticamente.
```

## 6. Algoritmo de roteamento

Pseudocódigo TypeScript:

```typescript
async function rotearItem(
  empresaVendedoraId: string,
  produtoId: string,
  qty: number,
): Promise<RotaResult> {
  // 1. Resolve home galpão da vendedora
  const empresa = await getEmpresa(empresaVendedoraId);
  const homeGalpao = await getGalpao(empresa.galpao_id);

  // 2. Tenta estoque próprio
  const proprio = await db.query(`
    SELECT e.*, g.cidade, g.estado FROM siso_estoque e
    JOIN siso_galpoes g ON g.id = e.galpao_id
    WHERE e.produto_id = $1
      AND e.empresa_dona_id = $2
      AND e.disponivel >= $3
    ORDER BY
      CASE
        WHEN e.galpao_id = $4 THEN 0
        WHEN g.cidade = $5 AND g.estado = $6 THEN 1
        WHEN g.estado = $6 THEN 2
        ELSE 3
      END,
      e.disponivel DESC
    LIMIT 1
  `, [produtoId, empresaVendedoraId, qty,
      homeGalpao.id, homeGalpao.cidade, homeGalpao.estado]);

  if (proprio.rows[0]) {
    return { tipo: 'propria', linha: proprio.rows[0] };
  }

  // 3. Empréstimo: busca credoras autorizadas
  const candidatos = await db.query(`
    SELECT e.*, g.cidade, g.estado FROM siso_estoque e
    JOIN siso_galpoes g ON g.id = e.galpao_id
    JOIN siso_emprestimo_regras r
      ON r.empresa_credora_id = e.empresa_dona_id
    WHERE e.produto_id = $1
      AND r.empresa_devedora_id = $2
      AND r.ativo = true
      AND e.disponivel >= $3
    ORDER BY
      CASE
        WHEN e.galpao_id = $4 THEN 0
        WHEN g.cidade = $5 AND g.estado = $6 THEN 1
        WHEN g.estado = $6 THEN 2
        ELSE 3
      END,
      e.disponivel DESC
    LIMIT 1
  `, [produtoId, empresaVendedoraId, qty,
      homeGalpao.id, homeGalpao.cidade, homeGalpao.estado]);

  if (candidatos.rows[0]) {
    return {
      tipo: 'emprestimo',
      linha: candidatos.rows[0],
      credoraId: candidatos.rows[0].empresa_dona_id,
      devedoraId: empresaVendedoraId,
    };
  }

  // 4. Sem cobertura → OC
  return { tipo: 'oc' };
}
```

**Pra pedidos com múltiplos itens:** roteamento é por item; cada item escolhe sua tripla independentemente. Decisão final do pedido (auto-aprovar ou ir pro painel humano) usa as decisões individuais agregadas:
- Todos itens próprios → auto-aprova (`propria`)
- Algum item OC → vai pra painel humano (`oc`)
- Todos cobertos mas com empréstimo → vai pra painel humano (`emprestimo`)

## 7. Reservas e concorrência

Lock pessimista via `SELECT FOR UPDATE`. Postgres serializa transações concorrentes na mesma linha de `siso_estoque`.

```typescript
async function reservar(
  produtoId: string,
  donaId: string,
  galpaoId: string,
  qty: number,
  pedidoId: string,
) {
  return await db.transaction(async (tx) => {
    const { rows: [estoque] } = await tx.query(`
      SELECT saldo, reservado FROM siso_estoque
      WHERE produto_id=$1 AND empresa_dona_id=$2 AND galpao_id=$3
      FOR UPDATE
    `, [produtoId, donaId, galpaoId]);

    if (!estoque || estoque.saldo - estoque.reservado < qty) {
      throw new EstoqueInsuficienteError({ produtoId, donaId, galpaoId, qty });
    }

    await tx.query(`
      INSERT INTO siso_movimentacoes (
        produto_id, empresa_dona_id, galpao_id,
        tipo, quantidade,
        saldo_anterior, saldo_posterior,
        reservado_anterior, reservado_posterior,
        origem_tipo, origem_id, criado_em
      ) VALUES (
        $1, $2, $3, 'R', $4,
        $5, $5,
        $6, $6 + $4,
        'reserva_pedido', $7, now()
      )
    `, [produtoId, donaId, galpaoId, qty,
        estoque.saldo, estoque.reservado, pedidoId]);

    await tx.query(`
      UPDATE siso_estoque
      SET reservado = reservado + $1, atualizado_em = now()
      WHERE produto_id=$2 AND empresa_dona_id=$3 AND galpao_id=$4
    `, [qty, produtoId, donaId, galpaoId]);
  });
}
```

**Granularidade do lock:** apenas a linha `(produto, dona, galpão)`. Outros pedidos pra outras triplas (mesmo produto, dona diferente, ou galpão diferente) não esperam.

**Timeout:** se transação concorrente segura o lock por mais que N segundos, retry com backoff. Pra evitar deadlock raro entre múltiplos itens, sempre lock em ordem determinística (ex: ORDER BY produto_id ASC).

## 8. Integração Tiny

### 8.1 SISO → Tiny (chamadas que SISO faz)

| Operação | Status | Notas |
|---|---|---|
| `getProdutoDetalhe` | ✅ Mantém | Lazy-load do catálogo SISO |
| `buscarProdutoPorSku` | ✅ Mantém | Resolve mapeamento por empresa |
| `getPedido` | ✅ Mantém | Detalhes do pedido pro processamento |
| `gerarNotaFiscal` | ✅ Mantém | Fiscal essencial |
| `criarMarcadoresPedido` | ✅ Mantém | Tagging |
| `criarAgrupamento` (etiqueta) | ✅ Mantém | Fluxo de expedição |
| `getEstoque` | ❌ Remove | Substituído por query SISO |
| `movimentarEstoque` | ❌ Remove | SISO grava direto no ledger |
| `lancarEstoqueNota` | ❌ Remove | SISO grava S no ledger via webhook |
| `estornarEstoque` | ❌ Remove | SISO faz mov estorno |

### 8.2 Tiny → SISO (webhooks que SISO escuta)

| Webhook | Decisão | Ação no SISO |
|---|---|---|
| Pedido novo | ✅ Mantém | Roteamento + reserva |
| NF venda autorizada | ✅ Mantém | Mov S + L |
| NF devolução | ✅ Adicionar | Insere em `siso_devolucoes_pendentes` |
| NF cancelada | ✅ Adicionar | Mov estorno automático |
| Estoque alterado manualmente | ❌ Ignora | Tiny saldo é fictício |

### 8.3 Saldo Tiny vai divergir — e tudo bem

Tiny não rejeita NF por saldo zero (confirmado pelo user). NF de venda emitida → Tiny saldo da empresa cai pra negativo livremente. Sem compensação no Tiny.

Time é orientado: **não olhar saldo no Tiny pra decidir nada operacional**. Verdade está no SISO.

## 9. Marketplace sync (escopo v2, não v1)

Marketplaces (ML, Shopee) puxam estoque do Tiny. Com Tiny saldo virando fictício, anúncios vão mostrar fora de estoque mesmo quando SISO sabe que tem.

V1 não trata. V2 vai precisar de estratégia:
- Push periódico de SISO pro Tiny (atualiza saldo do produto baseado em SISO)
- Estratégia conservadora (só próprio) ou otimista (próprio + emprestável) ou rateada
- Discussão a ter no momento do escopo v2.

## 10. Migração em fases

### Fase 0 — WMS standalone (zero acoplamento)

**Duração estimada:** 4-6 semanas.

**O que muda:**
- Cria tabelas novas (`siso_produtos`, `siso_produto_empresas`, `siso_estoque`, `siso_movimentacoes`, `siso_emprestimo_regras`).
- Adiciona colunas em `siso_galpoes` (cidade, estado, país).
- Telas novas no SISO (rota `/wms/*`):
  - Catálogo de produtos (CRUD)
  - Mapeamento produto ↔ empresa Tiny
  - Configuração de galpões (cidade, estado)
  - Matriz de empréstimos
  - Receber estoque (entrada manual)
  - Transferir entre galpões
  - Ajuste manual
  - Inventário (sessões de contagem)
  - Visualização de saldos (3 perspectivas: por dono, por galpão, por produto)
  - Visualização de ledger (filtros)
  - Dashboard de empréstimos pendentes (saldos credora ↔ devedora por par e por produto)
  - Snapshot inicial: bulk-load de saldo atual do Tiny pra `siso_estoque` (uma vez, marca como `inventario_inicial`).

**O que NÃO muda:**
- Webhook de pedido continua usando o fluxo atual (Tiny `getEstoque`).
- Decisão de roteamento continua usando schema legado.
- Worker continua chamando `lancarEstoqueNota` no Tiny.
- UI de pedidos/separação/compras inalterada.

**Critério de saída:** time validou todas as funcionalidades isoladamente. Catálogo populado, matriz configurada, entradas manuais funcionando, transferências e ajustes funcionando, ledger consistente em testes.

**Reversão:** trivial (drop tables, remover rotas).

### Fase 1 — Dual-write (escreve nos dois lados, lê do legado)

**Duração estimada:** 2-4 semanas.

**O que muda:**
- Webhook de pedido, ao processar, **adiciona escrita paralela** no novo ledger:
  - Reserva: insere mov R + UPDATE siso_estoque
  - NF webhook: insere mov S + L + UPDATE siso_estoque
- Worker continua chamando Tiny (legado).
- UI de pedidos lê do schema legado.
- Job comparativo roda em background: pra cada pedido novo, compara decisão de roteamento "novo" vs "antigo" e loga divergências.

**O que NÃO muda:**
- Comportamento visível ao operador é idêntico.
- Tiny continua sendo chamado pra estoque.

**Critério de saída:** dual-write rodando estável por 2 semanas, divergências resolvidas, comparativo aponta novo schema = legado em >99% dos casos.

**Reversão:** desligar dual-write (feature flag).

### Fase 2 — Shadow comparison (validação ativa)

**Duração estimada:** 2-4 semanas.

**O que muda:**
- Comparativo dual-write é amadurecido em dashboard com alertas por divergência.
- Operador pode forçar reconciliação manual em casos de divergência.
- Treinamento da equipe na nova UI (saldos, ledger, dashboard de empréstimos).

**Critério de saída:** zero divergência por 1 semana. Equipe confortável com nova UI.

### Fase 3 — Switch parcial (corte por empresa ou por SKU)

**Duração estimada:** 2 semanas.

**O que muda:**
- Liga "primeira leva" no novo schema. Opções:
  - **Por empresa:** NetAir lê do novo, NetParts continua no legado.
  - **Por SKU:** subset de SKUs migrados; resto continua no legado.
- Webhook usa novo roteamento pra SKUs/empresas migrados.
- Worker para de chamar `lancarEstoqueNota` no Tiny **pra esses casos**.
- Tiny continua recebendo NF de venda normal; saldo Tiny começa a divergir.

**Critério de saída:** 2 semanas de operação na primeira leva sem incidente operacional.

**Reversão:** flip a feature flag de volta. Schema legado ainda é dual-writed.

### Fase 4 — Switch completo + decoupling

**Duração estimada:** 1-2 semanas.

**O que muda:**
- Todas empresas e todos SKUs no novo schema.
- Worker para de chamar **qualquer** API de estoque do Tiny.
- Schema legado vira read-only.
- Mapeia escopo v2 (marketplace sync, devolução em volume, etc).

**Critério de saída:** todos os pedidos sendo processados corretamente pelo novo. Zero call de estoque pro Tiny.

**Reversão:** rollback complexo. Tem que ser certo.

## 11. Reconciliação e error handling

### 11.1 Job de reconciliação contínua (todas as fases)

```sql
-- Pra cada linha de siso_estoque, valida que saldo bate com ledger
SELECT
  e.produto_id,
  e.empresa_dona_id,
  e.galpao_id,
  e.saldo as saldo_estoque,
  COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                    WHEN m.tipo='S' THEN -m.quantidade
                    ELSE 0 END), 0) as saldo_calculado,
  e.saldo - COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                              WHEN m.tipo='S' THEN -m.quantidade
                              ELSE 0 END), 0) as divergencia
FROM siso_estoque e
LEFT JOIN siso_movimentacoes m
  ON m.produto_id = e.produto_id
  AND m.empresa_dona_id = e.empresa_dona_id
  AND m.galpao_id = e.galpao_id
GROUP BY e.produto_id, e.empresa_dona_id, e.galpao_id, e.saldo
HAVING e.saldo <> COALESCE(SUM(CASE WHEN m.tipo='E' THEN m.quantidade
                                    WHEN m.tipo='S' THEN -m.quantidade
                                    ELSE 0 END), 0)
```

Roda a cada 1h. Qualquer divergência = alerta crítico. Em modo automático: REBUILD da linha de `siso_estoque` a partir do ledger (autoritativo).

### 11.2 Saldo devedor por par credora ↔ devedora

Query agregada do ledger:

```sql
-- "Quanto NetParts deve a NetAir do produto X?"
WITH dividas AS (
  SELECT
    empresa_dona_id as credora,
    emprestimo_devedora_id as devedora,
    produto_id,
    SUM(CASE
      WHEN estorno_de IS NULL THEN quantidade
      ELSE 0
    END) as devido
  FROM siso_movimentacoes
  WHERE origem_tipo = 'emprestimo'
  GROUP BY empresa_dona_id, emprestimo_devedora_id, produto_id
)
SELECT
  d1.credora, d1.devedora, d1.produto_id,
  d1.devido - COALESCE(d2.devido, 0) as saldo_liquido
FROM dividas d1
LEFT JOIN dividas d2
  ON d1.credora = d2.devedora
  AND d1.devedora = d2.credora
  AND d1.produto_id = d2.produto_id
WHERE d1.devido > COALESCE(d2.devido, 0);
```

Saldo líquido = empréstimos diretos − empréstimos reversos − estornos. Quando vira zero ou negativo, dívida quitada.

### 11.3 Erros previstos

| Erro | Causa | Tratamento |
|---|---|---|
| `EstoqueInsuficienteError` na reserva | Race com outro pedido | Retry com backoff; se persistir, pedido vai pra painel humano |
| Webhook NF chega antes do pedido | Race natural | Insere em fila `aguardando_pedido` (já implementado) |
| NF venda referencia mov que não existe no ledger | Bug ou dual-write inconsistente | Alerta crítico; operador investiga |
| Devolução chega sem pedido conhecido | NF órfã | Fila manual de classificação |
| Catálogo Tiny mudou tiny_produto_id | Mudança em conta Tiny | Reconciliação no cadastro de produto |

## 12. Escopo v1 vs v2+

**v1:**
- Tudo até a Fase 4 da migração
- Telas listadas na Fase 0
- Webhooks, ledger, reservas, devoluções, transferências, ajustes, inventário, estorno

**v2 (escopo posterior):**
- Marketplace sync (push de saldo SISO → Tiny → ML/Shopee)
- Auto-import de NF de entrada (descontinua a entrada manual)
- Kits (montagem/desmontagem)
- Múltiplos depósitos por galpão (subdivisão física)
- RMA pra fornecedor com tracking de SLA
- Custo médio histórico (snapshots mensais)
- Fechamento contábil mensal

## 13. Open questions (a confirmar no plan/implementação)

1. **Volume mensal de devoluções** — se for muito alto (>50/mês), tela de classificação precisa de batch ops e search robusto.
2. **Como o operador escolhe galpão na entrada manual** — sempre opta na hora? Ou tem default por empresa? (Provavelmente default = home galpão da empresa, mas operador pode trocar).
3. **Reservas têm timeout?** Pedido aprovado mas que ficou parado >X horas sem NF — libera reserva automaticamente? Ou fica aberto até admin agir?
4. **Custo médio em empréstimos** — quando NetParts vende usando estoque NetAir, o custo da NF da NetParts deveria ser igual ao custo médio do estoque NetAir. Mas isso é só pra contabilidade interna; NF tem o preço de venda.
5. **Snapshot inicial** — Fase 0 vai bulk-load `getEstoque` do Tiny pra cada produto+empresa. Pode levar horas pra rodar. Aceitar e rodar 1x.
6. **Auto-quitação de empréstimo na devolução** — quando devolução íntegra de venda-com-empréstimo volta, debita 1 da dívida. E se a dívida já foi negativa por empréstimo reverso? Tratar como crédito da credora.

## 14. Glossário

| Termo | Definição |
|---|---|
| **Dono fiscal** | Empresa que pagou a NF de entrada. Tem o estoque "no nome dela" mesmo que não esteja fisicamente em galpão dela. |
| **Galpão físico** | Local onde a unidade está fisicamente armazenada. |
| **Empresa vendedora (V)** | Empresa que recebeu o pedido do marketplace e vai emitir NF pro cliente. |
| **Empresa credora (C)** | Empresa cuja NF de entrada cobriu aquela unidade. Quem "pagou" o estoque. |
| **Empresa devedora (D)** | Empresa que vendeu usando estoque que não é dela. Fica devendo C. |
| **Tripla** | (produto, empresa_dona, galpão) — unidade mínima de estoque. |
| **Ledger** | `siso_movimentacoes` — log imutável de toda movimentação. |
| **Empréstimo** | Movimentação `tipo='S' origem='emprestimo'` em que `empresa_dona_id` ≠ `emprestimo_devedora_id`. |
| **Tracker puro** | Modelo de empréstimo sem quitação ativa. Saldo devedor é só visualização; quita por fluxo reverso. |

---

**Fim do design.** Pronto pra revisão. Próximo passo após aprovação: invocar a skill `writing-plans` pra gerar plano de implementação task-by-task.
