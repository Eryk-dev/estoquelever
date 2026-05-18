# Compras Preditivo — "Radar do Comprador" — Design

**Data:** 2026-05-18
**Status:** Spec em revisão, aguardando aprovação pra plano de implementação
**Autor:** brainstorm com Eryk
**Abordagem escolhida:** A (Dashboard explicativo, sugere e comprador aprova)
**Depende de:** WMS Plano 5 concluído (ledger imutável, MV `siso_cobertura_estoque`, MV `siso_curva_abc`, `siso_produto_fornecedores` com lead time)

---

## 1. Resumo executivo

Hoje o módulo Compras é puramente **reativo**: existe só pra suprir itens de pedidos pendentes que caíram em `oc` (sem estoque na hora do webhook). O comprador não tem visibilidade preditiva — ele descobre que precisa comprar quando o pedido já entrou em ruptura.

Este spec adiciona uma **terceira aba** dentro de `/wms/compras` chamada **"Reposição"** (paralela às atuais "Comprar" e "Receber"). É uma tela única que ranqueia todos os SKUs ativos por **urgência de compra**, calculada a partir de:

- Demanda projetada (forecast por SKU+empresa+galpão)
- Saldo atual + reservas (do ledger WMS)
- Lead time observado/configurado por fornecedor
- Reorder Point (ROP) com safety stock calibrado por curva ABC

Pra cada linha, o comprador vê **a sugestão completa + uma coluna "Por quê?"** que abre um drawer explicando a matemática em linguagem natural ("Curva A, vendendo 3.2/dia ± 1.1, lead time Tiger 7d, vai zerar em 4d, ROP=29 e você tem 18, comprar 50").

Antes de sugerir compra, o sistema verifica **alternativas em hierarquia**: empréstimo N×N inter-empresa → SKU equivalente via Cross → comprar. Se uma alternativa cobre a falta, vira a sugestão primária (com "comprar" como fallback).

**Cold start explícito:** ledger vazio hoje. Mês 1 = "modo aprendizagem" (UI mostra banner, sugestões aparecem só pra SKUs com ≥14 dias de dados). Mês 2 em diante = modo pleno. Sem importação de histórico do Tiny (decisão do Eryk).

---

## 2. Contexto e motivação

### Estado atual

- `/wms/compras` tem 2 abas: **Comprar** (lista itens OC pendentes pra disparar pedido) e **Receber** (conferência de chegada).
- Toda compra é gatilhada **a posteriori**: pedido chega → webhook não acha estoque → vira `oc` → cai no Comprar.
- Comprador olha lista de OCs, agrupa por fornecedor mentalmente, dispara pedido no Tiny.
- Quando o item finalmente chega, separação retoma. **Cliente espera** durante todo esse ciclo (lead time + processamento).

### Problema

Pra autopeças com 500 SKUs ativos e perfil "ambos doem" (fast-movers em ruptura, slow-movers encalhados), o modelo reativo:

- **Causa rupturas evitáveis** — quando OC dispara, lead time + recebimento + guarda já comeram a paciência do cliente.
- **Não otimiza capital** — slow-movers não recebem sinal de "pare de comprar"; fast-movers não recebem sinal de "compre antes".
- **Não captura sazonalidade nem tendência** — depende inteiramente da memória do comprador.
- **Não usa o estoque do grupo** — comprador compra mesmo quando empresa irmã tem o SKU disponível (matriz N×N de empréstimos já existe mas não é exposta na decisão de compra).

### Por que agora

A Fase 0 do WMS está completa em staging:

- `siso_movimentacoes` (ledger imutável) registra toda venda/empréstimo/devolução com timestamp.
- `siso_curva_abc` (MV) classifica SKUs automaticamente por giro 30d.
- `siso_cobertura_estoque` (MV) computa dias de cobertura por SKU+empresa+galpão.
- `siso_produto_fornecedores` tem `lead_time_min/medio/max`, MOQ, múltiplo, preferencial.
- `siso_emprestimo_regras` tem matriz N×N com limites.

Tudo que falta é a **camada preditiva e prescritiva** em cima.

---

## 3. Decisões de design (com justificativas)

### 3.1 Por que Abordagem A (dashboard explicativo) e não B (autônomo) ou C (híbrido em camadas)

**Decisão:** A — uma tela única, comprador aprova item a item ou em lote.

**Por quê:**
- Volume baixo (<500 SKUs) não justifica engine prescritiva complexa.
- Comprador precisa aprender a confiar no modelo antes de delegar — transparência > automação no início.
- Ledger vazio → modelos imaturos por 1-3 meses → autonomia agora seria irresponsável.
- A é construível em 2-3 semanas; C levaria 6-8 semanas e entrega valor parecido no MVP.

### 3.2 Convive com Comprar/Receber, não substitui

**Decisão:** nova aba "Reposição" dentro de `/wms/compras`. Abas existentes continuam intactas.

**Por quê:**
- Fluxo reativo (OC pendente) ainda é necessário enquanto modelo amadurece.
- Risco-zero pra produção: se Reposição der pau, Comprar/Receber seguem funcionando.
- Permite cutover gradual: começamos com Reposição como "sugestão paralela", depois unificamos se quiser.

### 3.3 Forecast: SES + Croston por classificação automática de perfil

**Decisão:** dois modelos, escolhidos automaticamente:
- **SES (Simple Exponential Smoothing)** com α=0.3 pra SKUs **regulares** (perfil: ≥1 venda por semana em média nos últimos 30 dias, ≤30% dos dias com zero).
- **Croston (com correção SBA — Syntetos-Boylan)** pra SKUs **intermitentes** (perfil: gaps grandes entre vendas, >30% dos dias com zero).

**Por quê:**
- Holt-Winters precisa de >24 meses pra capturar sazonalidade anual — não temos.
- Holt (linear trend) é sensível a outliers em SKUs com poucos pontos.
- SES é o método mais robusto e simples pra demanda regular com pouco histórico.
- Croston é o padrão-ouro pra demanda intermitente (parts industry); SBA corrige o bias positivo do Croston original.
- Classificação automática (sem o comprador ter que escolher) — recalculada toda noite.

**O que NÃO vamos fazer agora (YAGNI):**
- Prophet / LightGBM / ML supervisionado (overkill pra <500 SKUs sem histórico)
- Detecção de sazonalidade semanal (precisa de ≥8 semanas — só ligamos depois)
- Detecção de tendência (Holt) — só ligamos quando passar 90 dias de dados

### 3.4 ROP + Safety Stock por classe ABC

**Decisão:** fórmula clássica de Reorder Point com safety stock proporcional à classe:

```
ROP = (lead_time_medio_dias × demanda_diaria_media) + SafetyStock

SafetyStock = Z[classe] × σ_demanda × √(lead_time_medio_dias)
```

Onde:
- `Z[A] = 2.05` (service level 98%)
- `Z[B] = 1.65` (service level 95%)
- `Z[C] = 1.28` (service level 90%)
- `σ_demanda` = desvio padrão da demanda diária nos últimos 30d (mínimo 7d)
- `lead_time_medio_dias` = `siso_produto_fornecedores.lead_time_medio` do fornecedor preferencial

**Por quê:**
- Sem histórico de NF de entrada (data de emissão OC vs data de chegada), não temos σ do lead time — usamos só σ da demanda. **TODO futuro:** quando tivermos 90+ dias de dados de recebimento, ligar fórmula completa com `σ_LT`.
- Z diferenciado por classe = padrão de indústria e óbvio pra comprador entender.
- Service level configurável globalmente (admin pode mudar os 3 Z na tela de Configurações).

### 3.5 Quantidade sugerida: cobertura até próximo ciclo (não EOQ)

**Decisão:** qty sugerida = `max(ROP × 2 - saldo_disponivel - em_transito, MOQ)`, arredondada pro múltiplo de compra.

**Por quê:**
- EOQ (`√(2DS/H)`) precisa de custo de pedido (S) e custo de carregamento (H) — não temos esses dados confiáveis hoje.
- "Cobrir até 2× ROP" é heurística simples e segura: garante que próxima ruptura está a >1 ciclo de distância.
- MOQ + múltiplo do `siso_produto_fornecedores` já são respeitados.
- **TODO futuro:** quando tivermos custo de pedido (S) parametrizado por fornecedor e custo de carregamento (H), ligar EOQ como sugestão alternativa.

### 3.6 Urgência: score 0-100 baseado em dias até ruptura vs lead time

**Decisão:** score numérico calculado como:

```
saldo_projetado_dia(t) = saldo_atual - reservado + em_transito - forecast_acumulado(t)
dia_ruptura = primeiro t onde saldo_projetado_dia(t) ≤ 0
folga_dias = dia_ruptura - lead_time_medio_dias

urgencia = clamp(0, 100, 50 - folga_dias × 10)
```

Faixas:
- **Crítico (≥80):** vai zerar antes do lead time chegar (ruptura iminente, mesmo comprando agora)
- **Alto (50-79):** vai zerar entre 1× e 1.5× lead time (precisa comprar essa semana)
- **Médio (20-49):** vai zerar entre 1.5× e 3× lead time (planejar)
- **Baixo (0-19):** cobertura confortável (ignorar por enquanto)

**Por quê:**
- Score numérico = fácil ordenar/filtrar.
- Baseado em "dias até ruptura vs lead time" = pergunta certa pro comprador ("dá tempo de comprar?").
- Considera estoque em trânsito (OCs já emitidas) — não duplica sugestão.

### 3.7 Alternativas em hierarquia antes de sugerir compra

**Decisão:** pra cada SKU em urgência ≥50, antes de sugerir "comprar X", checa nessa ordem:

1. **Empréstimo N×N:** alguma empresa do grupo tem `disponivel` suficiente pra cobrir o déficit, e existe regra em `siso_emprestimo_regras` permitindo emprestar? → sugestão primária vira "pegar emprestado de Empresa X em Galpão Y" (com botão pra criar reserva). Comprar fica como fallback secundário.
2. **Equivalente Cross:** algum SKU equivalente (via OEM compartilhado em `siso_produto_oems`) tem cobertura folgada? → sugestão primária vira "vender equivalente SKU-Y" (informativo). Continua sugerindo comprar o original, mas com prioridade reduzida.
3. **Comprar:** sugestão primária default — quantidade calculada + fornecedor preferencial.

**Por quê:**
- Empréstimo evita compra desnecessária se grupo já tem o estoque.
- Equivalente Cross informa o comprador que a "falta" é parcial (pode despachar substituto enquanto o original chega).
- Hierarquia é configurável globalmente (toggle por etapa em Configurações).

**O que NÃO vamos fazer agora (YAGNI):**
- Disparar empréstimo automaticamente (continua sendo decisão humana).
- Sugerir substituição automática em pedidos pendentes (responsabilidade do operador de separação, não do comprador).

### 3.8 Cold start: modo aprendizagem no mês 1

**Decisão:** no primeiro mês após ligar o módulo, comportamento diferenciado:

- Banner amarelo no topo da tela: "Modo aprendizagem ativo. Sugestões aparecem só pra SKUs com ≥14 dias de movimentação. Reabilita 100% em [data]."
- Coluna "Confiança" mostra um indicador (Alta/Média/Baixa) baseado no número de pontos de dados disponíveis.
- Pra SKUs com `<14 dias` de dados: linha aparece, mas qty sugerida é só `ROP - saldo` baseado em demanda média simples (sem σ, sem safety stock — risco aceito).
- Pra SKUs com `0 movs` desde que ligamos: linha NÃO aparece (não tem como prever).
- Botões de aprovação ficam ativos desde o dia 1 — comprador pode usar como suporte mesmo no modo aprendizagem.

**Por quê:**
- Modelo SES/Croston precisa de pelo menos 14 pontos pra ter variância significativa.
- Sem σ não tem safety stock — mostrar valor errado é pior que não mostrar.
- Transparência total: comprador sabe quando confiar e quando não.

### 3.9 Snapshot diário, não cálculo em tempo de request

**Decisão:** job noturno (00:30 BRT) refresca tudo. Tela lê só de `siso_reposicao_sugestoes`.

**Por quê:**
- Forecast de 500 SKUs com SES/Croston leva ~2-3 segundos (Node single-thread); fazer em tempo de request seria lento e duplicado.
- Comprador olha a tela várias vezes por dia — não muda nada minutos vs horas de freshness.
- Idempotência: job sempre faz upsert por `(sku, empresa_dona, galpao, data_calculo)`.
- Disparo manual: endpoint admin permite forçar refresh sob demanda (útil pra debug).

---

## 4. Modelos preditivos — fórmulas e pseudocódigo

### 4.1 Agregação de demanda diária

```sql
-- MV refresh nightly
CREATE MATERIALIZED VIEW siso_demanda_diaria AS
SELECT
  m.produto_id,
  m.empresa_dona_id,
  m.galpao_id,
  DATE(m.criada_em AT TIME ZONE 'America/Sao_Paulo') AS data,
  SUM(CASE WHEN m.tipo = 'S' AND m.origem_tipo IN ('nf_venda', 'emprestimo') THEN m.qty ELSE 0 END) AS qty_vendida,
  SUM(CASE WHEN m.tipo = 'S' AND m.origem_tipo = 'nf_venda' THEN m.qty ELSE 0 END) AS qty_venda_externa,
  SUM(CASE WHEN m.tipo = 'S' AND m.origem_tipo = 'emprestimo' THEN m.qty ELSE 0 END) AS qty_emprestimo_saida
FROM siso_movimentacoes m
WHERE m.estorno_de IS NULL
  AND m.criada_em >= NOW() - INTERVAL '90 days'
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX ON siso_demanda_diaria (produto_id, empresa_dona_id, galpao_id, data);
```

Demanda relevante = `qty_vendida` (vendas externas + saídas de empréstimo, ambas representam saída real do grupo). Estornos excluídos.

### 4.2 Classificação de perfil (regular vs intermitente)

```typescript
function classificarPerfil(serieDiaria: number[]): "regular" | "intermitente" | "sem_dados" {
  if (serieDiaria.length < 14) return "sem_dados";
  const zeros = serieDiaria.filter(v => v === 0).length;
  const pctZeros = zeros / serieDiaria.length;
  const mediaSemanal = (serieDiaria.reduce((a, b) => a + b, 0) / serieDiaria.length) * 7;
  if (pctZeros > 0.3 || mediaSemanal < 1) return "intermitente";
  return "regular";
}
```

### 4.3 SES (perfil regular)

```typescript
function forecastSES(serieDiaria: number[], horizonte: number = 30, alpha = 0.3): { mu: number; sigma: number } {
  // Nível inicial = média dos primeiros 7 dias
  let nivel = serieDiaria.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
  for (let i = 7; i < serieDiaria.length; i++) {
    nivel = alpha * serieDiaria[i] + (1 - alpha) * nivel;
  }
  // Erros residuais para σ
  const residuos: number[] = [];
  let n = serieDiaria.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
  for (let i = 7; i < serieDiaria.length; i++) {
    residuos.push(serieDiaria[i] - n);
    n = alpha * serieDiaria[i] + (1 - alpha) * n;
  }
  const sigma = Math.sqrt(residuos.reduce((s, e) => s + e * e, 0) / Math.max(1, residuos.length - 1));
  return { mu: nivel, sigma };  // mu é demanda diária projetada
}
```

### 4.4 Croston-SBA (perfil intermitente)

```typescript
function forecastCrostonSBA(serieDiaria: number[], alpha = 0.1): { mu: number; sigma: number } {
  // Separa em (tamanho da venda) e (intervalo entre vendas)
  const tamanhos: number[] = [];
  const intervalos: number[] = [];
  let gap = 0;
  for (const v of serieDiaria) {
    if (v > 0) {
      tamanhos.push(v);
      intervalos.push(gap + 1);
      gap = 0;
    } else {
      gap++;
    }
  }
  if (tamanhos.length < 2) return { mu: 0, sigma: 0 };
  // Suaviza tamanho e intervalo independentemente
  let z = tamanhos[0], p = intervalos[0];
  for (let i = 1; i < tamanhos.length; i++) {
    z = alpha * tamanhos[i] + (1 - alpha) * z;
    p = alpha * intervalos[i] + (1 - alpha) * p;
  }
  // Correção SBA elimina bias do Croston original
  const mu = (z / p) * (1 - alpha / 2);
  // σ proxy: variância dos tamanhos amostrais
  const media = tamanhos.reduce((a, b) => a + b, 0) / tamanhos.length;
  const sigma = Math.sqrt(tamanhos.reduce((s, t) => s + (t - media) ** 2, 0) / tamanhos.length);
  return { mu, sigma };
}
```

### 4.5 ROP + Safety Stock

```typescript
const Z_POR_CLASSE = { A: 2.05, B: 1.65, C: 1.28, sem_classe: 1.65 };  // default B

function calcularROP(opts: {
  classe: "A" | "B" | "C" | null;
  muDiario: number;
  sigmaDemanda: number;
  leadTimeDias: number;
}) {
  const Z = Z_POR_CLASSE[opts.classe ?? "sem_classe"];
  const safetyStock = Z * opts.sigmaDemanda * Math.sqrt(opts.leadTimeDias);
  const rop = (opts.leadTimeDias * opts.muDiario) + safetyStock;
  return { rop: Math.ceil(rop), safetyStock: Math.ceil(safetyStock) };
}
```

### 4.6 Urgência

```typescript
function calcularUrgencia(opts: {
  saldoAtual: number;
  reservado: number;
  emTransito: number;
  muDiario: number;
  leadTimeDias: number;
}): { score: number; diaRuptura: number | null; folgaDias: number } {
  const saldoEfetivo = opts.saldoAtual - opts.reservado + opts.emTransito;
  if (opts.muDiario <= 0) return { score: 0, diaRuptura: null, folgaDias: Infinity };
  const diaRuptura = Math.ceil(saldoEfetivo / opts.muDiario);
  const folgaDias = diaRuptura - opts.leadTimeDias;
  const score = Math.max(0, Math.min(100, 50 - folgaDias * 10));
  return { score, diaRuptura, folgaDias };
}
```

### 4.7 Qty sugerida

```typescript
function calcularQtySugerida(opts: {
  rop: number;
  saldoAtual: number;
  reservado: number;
  emTransito: number;
  moq: number;
  multiplo: number;
}): number {
  const alvo = opts.rop * 2;  // cobre até 2× ROP
  const deficit = alvo - (opts.saldoAtual - opts.reservado + opts.emTransito);
  if (deficit <= 0) return 0;
  let qty = Math.max(deficit, opts.moq);
  // Arredonda pra cima no múltiplo
  if (opts.multiplo > 1) qty = Math.ceil(qty / opts.multiplo) * opts.multiplo;
  return Math.ceil(qty);
}
```

### 4.8 Alternativas

```typescript
async function resolverAlternativas(opts: {
  produtoId: string;
  empresaDonaId: string;
  galpaoId: string;
  deficit: number;
}): Promise<Alternativa[]> {
  const out: Alternativa[] = [];

  // 1. Empréstimo N×N: outras empresas do grupo com disponivel
  const irmas = await buscarSaldoIrmas(opts.produtoId, opts.galpaoId, opts.empresaDonaId);
  for (const irma of irmas) {
    const regra = await buscarRegraEmprestimo(irma.empresa_id, opts.empresaDonaId);
    if (!regra) continue;
    const limite = regra.limite_por_produto?.[opts.produtoId] ?? regra.limite_max_por_produto ?? Infinity;
    const qtyEmprestavel = Math.min(irma.disponivel, opts.deficit, limite);
    if (qtyEmprestavel > 0) {
      out.push({
        tipo: "emprestimo",
        empresa_credora_id: irma.empresa_id,
        qty: qtyEmprestavel,
        custo: 0,
      });
    }
  }

  // 2. Equivalente Cross: SKUs com OEM compartilhado e cobertura folgada
  const equivalentes = await buscarEquivalentesViaOEM(opts.produtoId);
  for (const eq of equivalentes) {
    const cobertura = await buscarCobertura(eq.produto_id, opts.empresaDonaId, opts.galpaoId);
    if (cobertura && cobertura.status_cobertura === "ok" && cobertura.disponivel_total >= opts.deficit) {
      out.push({
        tipo: "equivalente",
        produto_id_equivalente: eq.produto_id,
        sku_equivalente: eq.sku,
        qty: opts.deficit,
        custo: 0,  // informativo
      });
    }
  }

  return out;
}
```

---

## 5. Schema

### 5.1 Materialized View `siso_demanda_diaria`

Já definida em §4.1. Refresh via `wms_refresh_demanda_diaria()` RPC (chamada pelo job noturno).

### 5.2 Tabela `siso_reposicao_sugestoes`

Snapshot diário do estado preditivo de cada SKU. **Tabela, não MV** — porque queremos audit histórico das sugestões.

```sql
CREATE TABLE siso_reposicao_sugestoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_calculo date NOT NULL,
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),

  -- Estado atual
  saldo_atual numeric NOT NULL,
  reservado numeric NOT NULL,
  em_transito numeric NOT NULL DEFAULT 0,  -- soma de OCs emitidas e não recebidas

  -- Perfil + classificação
  perfil_demanda text NOT NULL CHECK (perfil_demanda IN ('regular', 'intermitente', 'sem_dados')),
  classe_abc text CHECK (classe_abc IN ('A', 'B', 'C')),
  confianca text NOT NULL CHECK (confianca IN ('alta', 'media', 'baixa')),
  dias_de_dados int NOT NULL,  -- quantos dias de histórico no ledger

  -- Forecast
  mu_diario numeric NOT NULL,         -- demanda diária projetada
  sigma_diario numeric NOT NULL,      -- σ da demanda

  -- Reorder
  lead_time_dias numeric,             -- do fornecedor preferencial
  rop numeric,                        -- Reorder Point
  safety_stock numeric,

  -- Urgência
  urgencia_score smallint NOT NULL CHECK (urgencia_score BETWEEN 0 AND 100),
  urgencia_faixa text NOT NULL CHECK (urgencia_faixa IN ('critico', 'alto', 'medio', 'baixo')),
  dia_ruptura_em int,                 -- dias até zerar (NULL se não tem demanda)
  folga_dias int,                     -- dia_ruptura - lead_time

  -- Sugestão de compra
  qty_sugerida numeric NOT NULL DEFAULT 0,
  fornecedor_preferencial_id uuid REFERENCES siso_fornecedores(id),
  custo_unitario_estimado numeric,
  custo_total_estimado numeric,
  moq numeric,
  multiplo numeric,

  -- Alternativas (JSON pra simplicidade)
  alternativas jsonb NOT NULL DEFAULT '[]'::jsonb,  -- array de { tipo, empresa_id?, sku_equivalente?, qty, custo }
  acao_recomendada text NOT NULL CHECK (acao_recomendada IN ('emprestimo', 'equivalente', 'comprar', 'aguardar')),

  -- Explicação humana (geramos no job pra usar no drawer "por quê")
  explicacao_texto text,

  criada_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_reposicao_dia ON siso_reposicao_sugestoes (data_calculo, produto_id, empresa_dona_id, galpao_id);
CREATE INDEX idx_reposicao_urgencia ON siso_reposicao_sugestoes (data_calculo, urgencia_score DESC) WHERE acao_recomendada IN ('comprar', 'emprestimo');
CREATE INDEX idx_reposicao_fornecedor ON siso_reposicao_sugestoes (data_calculo, fornecedor_preferencial_id) WHERE acao_recomendada = 'comprar';
```

**Por que tabela e não MV:**
- Queremos histórico (saber o que sugerimos ontem mesmo após refresh de hoje).
- Queremos ligar `siso_reposicao_aprovacoes` a sugestões específicas via FK.
- Volume é baixo (500 SKUs × 365 dias × 2 anos = 365k linhas — irrelevante).

### 5.3 Tabela `siso_reposicao_aprovacoes`

Audit trail de cada ação do comprador. Alimenta aprendizado futuro (se modelo sugeriu 50 e ele aprovou 30, sinal de bias).

```sql
CREATE TABLE siso_reposicao_aprovacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sugestao_id uuid NOT NULL REFERENCES siso_reposicao_sugestoes(id),
  usuario_id uuid NOT NULL REFERENCES siso_usuarios(id),
  acao text NOT NULL CHECK (acao IN ('aprovou', 'rejeitou', 'ajustou', 'aprovou_emprestimo', 'adiou')),
  qty_aprovada numeric,            -- pode ser 0 (rejeitou), ou diferente da sugerida (ajustou)
  qty_sugerida_snapshot numeric,   -- congela a sugestão no momento da ação
  motivo text,
  ordem_compra_id uuid REFERENCES siso_ordens_compra(id),  -- se virou OC real
  emprestimo_mov_id uuid REFERENCES siso_movimentacoes(id), -- se virou empréstimo
  criada_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_aprovacoes_usuario ON siso_reposicao_aprovacoes (usuario_id, criada_em DESC);
CREATE INDEX idx_aprovacoes_sugestao ON siso_reposicao_aprovacoes (sugestao_id);
```

### 5.4 Tabela `siso_reposicao_config`

Configuração editável pelo admin (toggles globais).

```sql
CREATE TABLE siso_reposicao_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  z_classe_a numeric NOT NULL DEFAULT 2.05,
  z_classe_b numeric NOT NULL DEFAULT 1.65,
  z_classe_c numeric NOT NULL DEFAULT 1.28,
  z_sem_classe numeric NOT NULL DEFAULT 1.65,
  alpha_ses numeric NOT NULL DEFAULT 0.3,
  alpha_croston numeric NOT NULL DEFAULT 0.1,
  habilitar_emprestimo boolean NOT NULL DEFAULT true,
  habilitar_equivalente boolean NOT NULL DEFAULT true,
  cobertura_alvo_multiplicador numeric NOT NULL DEFAULT 2.0,  -- qty cobre 2× ROP
  dias_minimos_pra_sugerir smallint NOT NULL DEFAULT 14,
  data_ligado_em date,  -- usada pro banner de cold start
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO siso_reposicao_config (id) VALUES (1) ON CONFLICT DO NOTHING;
```

### 5.5 RPC `wms_calcular_em_transito`

Soma OCs emitidas e não recebidas pra cada (produto, empresa, galpão).

```sql
CREATE FUNCTION wms_calcular_em_transito(p_produto_id uuid, p_empresa_id uuid, p_galpao_id uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(oc_item.qty_pendente), 0)
  FROM siso_ordens_compra oc
  JOIN siso_ordens_compra_itens oc_item ON oc_item.ordem_compra_id = oc.id
  WHERE oc.status IN ('emitida', 'recebimento_parcial')
    AND oc.empresa_destino_id = p_empresa_id
    AND oc.galpao_destino_id = p_galpao_id
    AND oc_item.produto_id = p_produto_id;
$$;
```

(Assumindo que `siso_ordens_compra` e `siso_ordens_compra_itens` têm essas colunas. Se schema atual difere, ajustar.)

---

## 6. Pipeline (job noturno)

### 6.1 Endpoint

`POST /api/wms/reposicao/refresh?force=true` (protegido por `WORKER_SECRET`).

Modo `force=false` (default): pula se já rodou hoje. Modo `force=true`: roda mesmo se já rodou (pra debug).

### 6.2 Sequência

```typescript
// src/lib/wms/reposicao/refresh.ts
export async function refreshReposicaoDiaria() {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Refresh MV demanda diária
  await sb.rpc("wms_refresh_demanda_diaria");

  // 2. Lista todos os SKUs ativos com saldo > 0 OU com movimentação nos últimos 30d
  const skus = await listarSkusAtivos();

  // 3. Pra cada SKU, calcular tudo
  const config = await carregarConfig();
  const sugestoes: SugestaoInput[] = [];
  for (const sku of skus) {
    const serie = await carregarDemandaDiaria(sku.produto_id, sku.empresa_dona_id, sku.galpao_id, 90);
    const perfil = classificarPerfil(serie);

    let mu = 0, sigma = 0;
    if (perfil === "regular") ({ mu, sigma } = forecastSES(serie, 30, config.alpha_ses));
    else if (perfil === "intermitente") ({ mu, sigma } = forecastCrostonSBA(serie, config.alpha_croston));

    const classe = await buscarClasseABC(sku.produto_id, sku.galpao_id);
    const fornPref = await buscarFornecedorPreferencial(sku.produto_id);
    const leadTime = fornPref?.lead_time_medio ?? 14;  // default 14d se não tem fornecedor cadastrado
    const { rop, safetyStock } = calcularROP({ classe, muDiario: mu, sigmaDemanda: sigma, leadTimeDias: leadTime });

    const emTransito = await calcularEmTransito(sku);
    const urgencia = calcularUrgencia({ saldoAtual: sku.saldo, reservado: sku.reservado, emTransito, muDiario: mu, leadTimeDias: leadTime });
    const qty = calcularQtySugerida({ rop, saldoAtual: sku.saldo, reservado: sku.reservado, emTransito, moq: fornPref?.qty_minima_pedido ?? 1, multiplo: fornPref?.multiplo_compra ?? 1 });

    const alternativas = await resolverAlternativas({ produtoId: sku.produto_id, empresaDonaId: sku.empresa_dona_id, galpaoId: sku.galpao_id, deficit: qty });
    const acao = decidirAcao({ urgencia, alternativas, qty, config });
    const explicacao = gerarExplicacao({ classe, perfil, mu, sigma, leadTime, rop, urgencia, alternativas, qty });

    sugestoes.push({ /* todos os campos da tabela */ });
  }

  // 4. Upsert em lote
  await sb.from("siso_reposicao_sugestoes").upsert(sugestoes, { onConflict: "data_calculo,produto_id,empresa_dona_id,galpao_id" });
}
```

### 6.3 Performance esperada

- 500 SKUs × ~5ms/sku = 2.5s
- Refresh MV demanda diária = ~1s
- Upsert batch = ~500ms
- **Total: ~4s** (aceitável pra cron noturno)

### 6.4 Cron

Cron Supabase + endpoint protegido por `WORKER_SECRET`. Schedule: `30 0 * * *` (00:30 BRT).

---

## 7. UI/UX da tela "Reposição"

### 7.1 Layout geral

Página: `src/app/wms/compras/page.tsx` ganha uma terceira tab "Reposição".

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Comprar] [Receber] [▶ Reposição]                                   │
├─────────────────────────────────────────────────────────────────────┤
│ ⚠ Modo aprendizagem ativo até 17/06. Sugestões parciais.            │
├─────────────────────────────────────────────────────────────────────┤
│ [🔍 Buscar]  Curva: [Todas] Urgência: [≥Médio] Galpão: [CWB] Forn:  │
├─────────────────────────────────────────────────────────────────────┤
│ ☐ SKU       Descrição        Galpão  Curva  Urg  Saldo  Cob.  Sug. │
│ ☐ 19FILTRO  Filtro de ar...  CWB     A      87   12    3d    50    │
│ ☐ EW123     Tergaz...        SP      A      72   18    5d    30    │
│ ☐ LD-X      LDRU pastilha    SP      B      55   42    11d   60    │
│ ☐ MK4321    MRMK velas       CWB     C      33   8     20d   12    │
│ ...                                                                 │
├─────────────────────────────────────────────────────────────────────┤
│  [3 selecionados] [Aprovar selecionados] [Exportar CSV]             │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 Colunas da tabela

| Coluna | Conteúdo | Notas |
|---|---|---|
| ☐ | Checkbox seleção | |
| SKU | `19FILTRO123` | Linkado pro Cross |
| Descrição | `Filtro de ar Toyota Corolla` | Truncado se longo |
| Galpão | `CWB` | |
| Curva | Badge A/B/C/— | A turquoise, B amarelo, C cinza |
| Urgência | Badge + score | Crítico vermelho / Alto laranja / Médio amarelo / Baixo cinza |
| Saldo | Saldo disponível atual | Tooltip mostra `saldo − reservado + em_trânsito` |
| Cobertura | `3d` ou `∞` | Dias até zerar com saldo efetivo |
| Sugestão | qty | Highlight se ≠ 0 |
| Ação primária | "Comprar 50" / "Pegar 30 emprestado" / "Substituir EQ-X" | Cor por tipo |
| **Por quê?** | Botão `?` | Abre drawer |
| ⚡ | Botão "Aprovar" | Inline |

### 7.3 Filtros

- **Busca:** SKU, descrição, OEM (via Cross)
- **Curva ABC:** multi-select (A/B/C/sem classe)
- **Urgência mínima:** dropdown (Todos / ≥Baixo / ≥Médio / ≥Alto / Crítico)
- **Galpão:** dropdown
- **Fornecedor preferencial:** dropdown (lista de `siso_fornecedores`)
- **Ação recomendada:** chips (Comprar / Empréstimo / Equivalente / Aguardar)

Default ao abrir: Urgência ≥Médio, galpão do usuário se cargo `operador_*`, todos os fornecedores.

### 7.4 Drawer "Por quê?"

Painel lateral que abre clicando no `?` da linha. Conteúdo:

```
Filtro de ar Toyota Corolla
SKU 19FILTRO123 · Curva A · CWB

📊 Demanda
  Perfil: regular (média 3.2/dia ± 1.1)
  Últimos 30 dias: ▁▂▃█▄▂▁▃▄... (sparkline)
  Confiança: Alta (42 dias de dados)

📦 Estoque
  Saldo atual: 18
  Reservado: 6 (3 pedidos pendentes)
  Em trânsito: 0 (nenhuma OC emitida)
  Saldo efetivo: 12

⚙ Cálculo
  Lead time Tiger: 7d (médio)
  Demanda × Lead time: 22.4
  Safety stock (Z=2.05, classe A): 7
  ROP: 29
  Cobertura alvo (2× ROP): 58
  Déficit: 58 − 12 = 46
  MOQ Tiger: 10, múltiplo: 5
  Qty sugerida: 50

⏱ Urgência
  Vai zerar em: 4 dias
  Folga vs lead time: −3 dias (vai zerar antes!)
  Score: 80 (Crítico)

🔄 Alternativas consideradas
  ❌ Empréstimo: NetParts CWB tem 4 disponíveis, abaixo do déficit
  ❌ Equivalente Cross: 2 SKUs com OEM compartilhado, ambos em ruptura

✅ Ação recomendada: Comprar 50 da Tiger
   Custo estimado: R$ 1.250,00
```

### 7.5 Ações em lote

Comprador seleciona N linhas → clica "Aprovar selecionados" → modal:

```
Você está aprovando 3 sugestões:

📦 1 empréstimo
  • LD-X de NetParts → NetAir (30 un) — criar reserva agora?

📦 2 compras
  • 19FILTRO123 → Tiger, 50 un, R$ 1.250
  • EW123 → Tiger, 30 un, R$ 600

  Tiger consolidado: 80 unidades, R$ 1.850

[Cancelar] [Confirmar tudo]
```

Ao confirmar:
- Empréstimos viram reserva via `wms_reservar_atomico` (com tipo `R`, origem `emprestimo`).
- Compras viram OCs (1 OC por fornecedor, agrupando itens) usando o fluxo existente do Comprar.
- Cada ação gera 1 row em `siso_reposicao_aprovacoes`.

### 7.6 Edição de qty

Linha tem qty editável inline (input numérico). Ao mudar:
- Recalcula custo total local
- Marca a linha com badge "ajustada"
- Ao aprovar, salva `qty_aprovada ≠ qty_sugerida` em `siso_reposicao_aprovacoes` (sinal de aprendizado)

### 7.7 Rejeitar/adiar

Botão menu (...) por linha:
- **Rejeitar:** marca como rejeitada (não aparece amanhã pra mesma situação a menos que urgência aumente). Pede motivo opcional.
- **Adiar 7 dias:** some da tela por 7 dias. Reaparece se urgência subir.

---

## 8. Cold start — plano explícito

### Mês 1 (semanas 1-4)

- **Dia 0:** ligamos o job, MV `siso_demanda_diaria` começa a popular.
- **Tela:** banner amarelo "Modo aprendizagem ativo até [data_ligado_em + 30 dias]". Aviso claro: "sugestões parciais — confiança baixa nos primeiros 14 dias".
- **Coluna "Confiança":**
  - **Baixa:** `<14 dias de dados` → não calcula safety stock (Z=0), qty sugerida = `max(0, ROP_simples - saldo)` onde `ROP_simples = lead_time × demanda_media_simples`.
  - **Média:** `14-30 dias de dados` → safety stock com Z reduzido em 30% (mais conservador).
  - **Alta:** `≥30 dias` → fórmula plena.
- **SKUs sem dados** (`0 movs` desde que ligamos): NÃO aparecem na tela. Banner cita a contagem ("142 SKUs ainda sem dados — eles vão aparecer conforme vendas acontecerem").
- **Comprador pode usar normalmente** — modo aprendizagem não bloqueia ações, só sinaliza incerteza.

### Mês 2+

- Banner some automaticamente quando `now() - data_ligado_em > 30 days`.
- Coluna "Confiança" continua existindo (Baixa pra SKUs novos que entrarem depois).

### Importação opcional (escopo futuro, não MVP)

Se mês 1 frustrar muito, podemos importar histórico do Tiny via API `/vendas` filtrando últimos 90 dias e inserir como `siso_movimentacoes` simuladas com `origem_tipo='nf_venda_historica'` e flag pra não afetar saldo. **Não fazemos no MVP** (decisão do Eryk).

---

## 9. Métricas de sucesso

Adicionar dashboard em `/wms/insights` (existente) com 4 cards novos:

1. **Fill-rate semanal:** % de pedidos novos que tiveram estoque na hora do webhook (não caíram em `oc`). Meta: ≥95% após 60 dias.
2. **Capital em estoque:** Σ `saldo × custo_medio` por classe ABC. Acompanhar trend semanal — esperamos baixar capital em classe C, manter em A/B.
3. **Sugestões aprovadas vs ignoradas:** taxa de aprovação por classe + por urgência. Se Crítico tem alto rejeite, modelo tá errado.
4. **Acurácia do forecast (MAE/MAPE):** `Σ|forecast_dia - real_dia| / Σ real_dia` por classe. Meta: <30% MAPE pra classe A após 90 dias.

Refresh: noturno, mesmo job.

---

## 10. Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Modelo sugere absurdos no mês 1 (pouco dado) | Alta | Banner aprendizagem + coluna Confiança + Z reduzido pra baixa confiança |
| Comprador ignora sistema porque "sabe melhor" | Média | Drawer "Por quê?" com transparência total + audit trail de aprovações alimentando refinamento |
| Lead time configurado errado nos fornecedores | Alta | Tela de admin pra editar; alerta na MV de cobertura quando lead time = NULL; **TODO futuro:** medir lead time real via NF de entrada |
| Equivalentes Cross com OEM ruim sugerem substitutos errados | Média | Por padrão equivalente é só informativo, não substitui a sugestão de comprar |
| Empréstimo automático sem aprovação cria caos | Mitigado | NÃO temos automação. Comprador sempre aprova manualmente. |
| Job noturno falha silenciosamente | Baixa | Endpoint de health check; alert via `siso_erros` se job > 24h sem rodar |
| Volume de sugestões esmaga comprador (>100 linhas/dia) | Baixa (500 SKUs) | Default filtro Urgência ≥Médio; ranking por score |

---

## 11. Out of scope (YAGNI explícito)

- ❌ Sistema autônomo que dispara compras sem aprovação
- ❌ Carrinho consolidado por fornecedor (deixa pra V2 se valer a pena — abordagem C original)
- ❌ EOQ (precisa de custo de pedido + carregamento parametrizados)
- ❌ Holt-Winters (precisa >24 meses, não temos)
- ❌ Detecção automática de sazonalidade (precisa de ciclos completos)
- ❌ ML supervisionado (Prophet, LightGBM) — overkill pra <500 SKUs
- ❌ Importar histórico do Tiny (decisão do Eryk: começa do zero)
- ❌ Forecasting de preço de fornecedor
- ❌ Negociação de descontos automática
- ❌ σ do lead time (precisa histórico de NF de entrada)
- ❌ Multi-objective optimization (capital × fill-rate × frete)
- ❌ Recomendação de quais SKUs descontinuar (slow-mover detection — pode entrar em insights, não em compras)

---

## 12. Plano de fases sugerido (será detalhado no plano de implementação)

**Fase 1 — Foundation (semana 1-2):**
- Migrations: 4 objetos novos (MV `siso_demanda_diaria`, tabelas `siso_reposicao_sugestoes`, `siso_reposicao_aprovacoes`, `siso_reposicao_config`)
- Lib `src/lib/wms/reposicao/` com testes unitários pra cada função (`forecast.ts`, `rop.ts`, `urgencia.ts`, `alternativas.ts`)

**Fase 2 — Job + API (semana 2-3):**
- Endpoint `POST /api/wms/reposicao/refresh`
- Endpoint `GET /api/wms/compras/reposicao` (lista filtrada)
- Endpoint `GET /api/wms/compras/reposicao/[sku]/explicacao` (drawer)
- Endpoint `POST /api/wms/compras/reposicao/aprovar` (cria OC ou empréstimo)
- Cron Supabase nightly 00:30 BRT

**Fase 3 — UI (semana 3-4):**
- Nova tab "Reposição" em `/wms/compras`
- Tabela com filtros + drawer "por quê" + ações em lote
- Banner cold start condicional

**Fase 4 — Métricas (semana 4-5):**
- Cards em `/wms/insights`: fill-rate, capital, taxa aprovação, MAE/MAPE

**Fase 5 — Tela de configuração (semana 5):**
- `/wms/configuracoes/reposicao` pra admin editar Z's, alpha's, toggles

---

## 13. Open questions (pra discutir no plano)

1. **Como integrar com fluxo existente de OC?** Quando comprador aprova "comprar 50 da Tiger", o sistema cria registro em `siso_ordens_compra`? Ou só dispara a OC no Tiny? Precisa revisar o módulo Comprar atual pra entender o ciclo.
2. **Multi-galpão:** se SKU tem demanda em ambos CWB e SP, sugere comprar pra cada um separadamente ou consolida? Default: separado (cada empresa+galpão é uma row).
3. **Equivalentes Cross:** hoje a relação é `siso_produto_oems` (OEM compartilhado). Critério de "equivalente" = pelo menos 1 OEM em comum? Ou precisa >50% de overlap? Conversar.
4. **Onde a configuração de service level fica?** Sugerido em `/wms/configuracoes/reposicao` mas precisa decidir se admin ou comprador edita.
5. **Notificações:** quando SKU entra em "Crítico", manda notificação push pro comprador? Email? Por enquanto, fica só passivo (comprador olha a tela).
