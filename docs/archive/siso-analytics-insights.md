# SISO Analytics: Relatório Abrangente de Insights de Dados

## PARTE 1: DIALOGO OPERACIONAL

---

**LP (Especialista em Logistica e Compras):** Preciso te situar no contexto antes de qualquer coisa. O SISO processa em torno de 500 pedidos por dia provenientes de quatro marketplaces — Mercado Livre, Shopee, Amazon e Magalu — divididos entre dois galpoes: CWB (Curitiba, empresa NetAir) e SP (Sao Paulo, empresa NetParts). Quando um pedido chega pelo webhook do Tiny ERP, o sistema verifica estoque em TODAS as empresas do grupo Autopecas e toma uma decisao: atender com estoque proprio (`propria`), transferir de outro galpao (`transferencia`) ou abrir uma Ordem de Compra com fornecedor (`oc`).

O problema que mais me tira o sono hoje nao e o volume. E a ruptura de estoque que gera OC. Quando um pedido vai para `aguardando_compra`, ele entra num limbo: depende do fornecedor, depende do comprador fazer a OC, e o prazo de envio do marketplace continua correndo. Frequentemente chegamos tarde. Segundo problema: nao temos visibilidade preditiva. Eu sei o que ta atrasado hoje, mas nao sei o que vai atrasar amanha.

**DS (Data Scientist):** Entendido. Antes de ir para os modelos, preciso entender a granularidade temporal dos dados. O `siso_pedido_historico` registra cada transicao de estado com timestamp — isso e ouro para calcular lead times por etapa. Mas me responde: com quanto tempo de historico estamos trabalhando? As migrations mais antigas sao de marco de 2026 e hoje e 30 de marco de 2026. Entao temos menos de um mes de dados transacionais reais?

**LP:** Sim, o sistema foi ao ar em producao por volta de 9 de marco. Entao temos aproximadamente tres semanas de historico real. Uns 10 a 15 mil pedidos acumulados ja.

**DS:** Tres semanas com 500 pedidos/dia nos dao aproximadamente 10.500 pedidos, com 3 a 5 itens por pedido — entao entre 31.500 e 52.500 linhas em `siso_pedido_itens`. E suficiente para analise descritiva robusta, series temporais curtas e deteccao de padroes. Para modelos preditivos com sazonalidade anual, ainda nao temos dados suficientes — mas podemos construir a infraestrutura agora e alimentar o modelo conforme o historico cresce. Vou checar o que existe em termos de timestamps. O `siso_pedidos` tem `criado_em`, `processado_em`, `separacao_iniciada_em`, `separacao_concluida_em`, `embalagem_concluida_em`. O `siso_pedido_itens` tem `bipado_em`, `compra_solicitada_em`, `comprado_em`, `recebido_em`. Isso nos permite calcular o tempo em cada estagio para cada pedido individualmente. Excelente.

**LP:** O que mais me preocupa e o comportamento dos fornecedores. Temos pelo menos doze fornecedores mapeados no `sku-fornecedor.ts` — ACA, Multiqualita, Tiger, GAUSS, LDRU, LEFS, MRMK, Delphi, Kintop, e outros. Para cada um, o tempo entre `compra_solicitada_em` e `recebido_em` e completamente diferente. Alguns entregam em 2 horas, outros em 3 dias. O comprador hoje trata todo mundo igual porque nao tem esse dado sistematizado.

**DS:** Isso e um ponto de altissimo valor. Com `compra_solicitada_em`, `comprado_em` e `recebido_em` em `siso_pedido_itens`, combinados com `fornecedor_oc` e `sku`, podemos calcular dois lead times distintos: (1) tempo do comprador para abrir a OC (`compra_solicitada_em` ate `comprado_em`) e (2) tempo do fornecedor para entregar (`comprado_em` ate `recebido_em`). Isso permite separar ineficiencia interna de externa. E com tres semanas de dados ja temos historico suficiente para alguns fornecedores.

**LP:** Exato. Outro ponto critico: as `separacao_tags`. Operadores podem marcar pedidos manualmente com tags como "frагil", "urgente", "cliente-vip". Mas nao ha nenhuma logica automatica por tras disso — e puramente manual. Seria possivel automatizar pelo menos parte dessas classificacoes?

**DS:** Sim. Com base em `prazo_envio` versus `criado_em` podemos calcular o slack de tempo disponivel e classificar automaticamente como urgente sem precisar de intervencao humana. Mais do que isso: com `nome_ecommerce`, `forma_envio_descricao` e historico de pedidos por `cliente_cpf_cnpj`, podemos identificar padroes — clientes recorrentes, pedidos de alto volume de itens, pedidos com historico de cancelamento. Isso abre caminho para prioridade dinamica no picking.

**LP:** Falando em picking: o sistema de wave picking esta funcionando bem no geral, mas nao ha otimizacao de rota. O operador bipa na ordem que ele quiser. Temos `localizacao` em `siso_pedido_item_estoques` — poderia usar isso para sugerir uma rota otima?

**DS:** Absolutamente. A `localizacao` armazena uma string de localizacao fisica no galpao. Se o formato for padronizado — tipo "A-01-03" para corredor A, prateleira 01, posicao 03 — podemos construir um parser simples e calcular distancias euclidianas entre posicoes. Com isso, para um conjunto de itens de uma ola de separacao, aplicamos TSP (Traveling Salesman Problem) aproximado via algoritmo do vizinho mais proximo ou 2-opt. Para volumes pequenos de itens por ola, isso e computacionalmente trivial.

**LP:** Perfeito. Agora o problema mais estrategico: a decisao `oc` versus `transferencia`. Hoje quando o sistema sugere `oc`, e porque nenhum dos dois galpoes tem o produto. Mas algumas vezes — estou suspeitando — o estoque existe em algum lugar mas nao esta sendo capturado corretamente porque houve algum lag no webhook ou o produto esta como "reservado" no Tiny. Estou perdendo vendas por falsos negativos?

**DS:** Isso e investigavel. A tabela `siso_pedido_item_estoques` guarda o snapshot de estoque no momento do webhook — `saldo`, `reservado`, `disponivel`. Podemos comparar pedidos que foram para `oc` e depois, ao receber a compra, tinham `recebido_em` muito rapido — isso pode indicar que o produto ja existia no estoque fisico e foi comprado desnecessariamente. Alem disso, cruzando com inventarios subsequentes (`siso_inventario_itens` com `saldo_anterior_tiny`), podemos identificar SKUs que estavam com `disponivel = 0` no momento da decisao mas tinham saldo fisico alto no inventario seguinte — evidencia direta de falso negativo.

**LP:** E o Mercado Livre tem uma dinamica diferente do Shopee em termos de prazo de envio. No ML, um atraso de mais de 24h pode gerar cancelamento automatico e penalizacao do vendedor. No Shopee, ha mais flexibilidade. Isso muda completamente a prioridade de separacao.

**DS:** E modelavel. Com `nome_ecommerce` e `prazo_envio`, podemos calcular o slack por canal e criar um score de prioridade dinamico que considera: (1) canal — ML tem penalizacao maior; (2) prazo_envio - now(); (3) decisao_final — pedidos `oc` tem risco inerente maior; (4) valor do pedido se disponivel. Isso e um modelo de ranking simples mas de alto impacto imediato.

**LP:** Ultimo ponto: o custo de transferencia. Quando o sistema decide `transferencia`, ha um custo real de frete entre CWB e SP que hoje nao e quantificado em lugar nenhum no sistema. Como voce abordaria isso?

**DS:** Nao temos valor de frete diretamente no banco. Mas podemos estimar pelo volume de pedidos `transferencia` ao longo do tempo usando `siso_transferencias` — que registra transferencias de estoque com quantidades e SKUs. Combinado com a frequencia de decisao `transferencia` em `siso_pedidos`, podemos calcular o custo de oportunidade de nao ter o produto no galpao certo. A logica e: frequencia de transferencia por SKU x custo estimado de transferencia = custo de distribuicao impropia de estoque. Isso diretamente justifica qual SKU deve ter estoque duplicado nos dois galpoes.

---

## PARTE 2: CATALOGO DE INSIGHTS

---

### CATEGORIA 1: PREVISAO DE DEMANDA

---

**INSIGHT 1.1 — Previsao de Volume Diario por Canal**

**Pergunta de Negocio:** Quantos pedidos vao chegar amanha, por canal (ML, Shopee, Amazon, Magalu)?

**Fontes de Dados:**
- `siso_pedidos`: `nome_ecommerce`, `criado_em`, `status`

**Abordagem SQL/Analitica:**
```sql
-- Serie temporal de pedidos por canal e dia
SELECT
  DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') AS dia,
  CASE
    WHEN LOWER(nome_ecommerce) LIKE '%mercado livre%' THEN 'Mercado Livre'
    WHEN LOWER(nome_ecommerce) LIKE '%shopee%'        THEN 'Shopee'
    WHEN LOWER(nome_ecommerce) LIKE '%amazon%'        THEN 'Amazon'
    WHEN LOWER(nome_ecommerce) LIKE '%magalu%'        THEN 'Magalu'
    ELSE 'Outros'
  END AS canal,
  COUNT(*) AS total_pedidos,
  EXTRACT(DOW FROM criado_em AT TIME ZONE 'America/Sao_Paulo') AS dia_semana
FROM siso_pedidos
WHERE status NOT IN ('cancelado')
GROUP BY 1, 2, 4
ORDER BY 1, 2;

-- Media movel 7 dias por canal
SELECT canal, dia,
  AVG(total_pedidos) OVER (
    PARTITION BY canal
    ORDER BY dia
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS media_movel_7d
FROM (/* subquery acima */) t;
```

Modelo: Media movel ponderada (WMA-7) como baseline imediato. Ao acumular 90+ dias, migrar para Prophet ou SARIMA com componente de dia-da-semana.

**Complexidade:** Simples (SQL puro com window functions)

**Impacto de Negocio:** Alto — permite dimensionar equipe de separacao com antecedencia de 24-48h

**Quick Win:** Sim

---

**INSIGHT 1.2 — Previsao de Demanda por SKU**

**Pergunta de Negocio:** Quais SKUs vao ser mais demandados na proxima semana? Quando vou precisar recomprar?

**Fontes de Dados:**
- `siso_pedido_itens`: `sku`, `descricao`, `quantidade_pedida`, `pedido_id`
- `siso_pedidos`: `criado_em`, `status`

**Abordagem SQL/Analitica:**
```sql
-- Ranking de SKUs por demanda semanal
SELECT
  pi.sku,
  pi.descricao,
  DATE_TRUNC('week', p.criado_em AT TIME ZONE 'America/Sao_Paulo') AS semana,
  SUM(pi.quantidade_pedida) AS unidades_demandadas,
  COUNT(DISTINCT pi.pedido_id) AS pedidos_distintos,
  -- Frequencia de OC para este SKU
  COUNT(*) FILTER (WHERE pi.compra_status IS NOT NULL) AS vezes_em_oc,
  ROUND(
    COUNT(*) FILTER (WHERE pi.compra_status IS NOT NULL)::numeric /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS pct_via_oc
FROM siso_pedido_itens pi
JOIN siso_pedidos p ON p.id = pi.pedido_id
WHERE p.status NOT IN ('cancelado')
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

Modelo: Para os top-50 SKUs por volume, aplicar modelo de suavizacao exponencial (Holt-Winters) com componente de dia-da-semana quando o historico superar 60 dias.

**Complexidade:** Media

**Impacto de Negocio:** Alto — base para politica de estoque minimo e ponto de reposicao

**Quick Win:** Sim (analise descritiva imediata)

---

**INSIGHT 1.3 — Padroes Intradiarios de Demanda**

**Pergunta de Negocio:** Em que horarios chegam mais pedidos? Quando devo ter mais operadores disponivel?

**Fontes de Dados:**
- `siso_pedidos`: `criado_em`, `nome_ecommerce`, `empresa_origem_id`

**Abordagem SQL/Analitica:**
```sql
SELECT
  EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Sao_Paulo') AS hora,
  EXTRACT(DOW FROM criado_em AT TIME ZONE 'America/Sao_Paulo') AS dia_semana,
  COUNT(*) AS total_pedidos,
  ROUND(AVG(COUNT(*)) OVER (PARTITION BY EXTRACT(DOW FROM criado_em AT TIME ZONE 'America/Sao_Paulo')), 1) AS media_dia_semana
FROM siso_pedidos
WHERE status NOT IN ('cancelado')
GROUP BY 1, 2
ORDER BY 2, 1;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — escalonamento de turnos dos operadores

**Quick Win:** Sim

---

**INSIGHT 1.4 — Deteccao de Sazonalidade por Categoria de Produto**

**Pergunta de Negocio:** Algum grupo de SKUs tem picos sazonais previsivel (ex: inverno CWB aumenta demanda de aquecedores automotivos)?

**Fontes de Dados:**
- `siso_pedido_itens`: `sku`, `fornecedor_oc`, `quantidade_pedida`
- `siso_pedidos`: `criado_em`

**Abordagem SQL/Analitica:**
```sql
-- Demanda por fornecedor/semana para identificar sazonalidade por categoria
SELECT
  pi.fornecedor_oc,
  DATE_TRUNC('week', p.criado_em) AS semana,
  SUM(pi.quantidade_pedida) AS total_unidades,
  COUNT(DISTINCT pi.pedido_id) AS pedidos
FROM siso_pedido_itens pi
JOIN siso_pedidos p ON p.id = pi.pedido_id
WHERE pi.fornecedor_oc IS NOT NULL
  AND p.status NOT IN ('cancelado')
GROUP BY 1, 2
ORDER BY 1, 2;
```

**Complexidade:** Media (requer 6+ meses de dados para sazonalidade anual)

**Impacto de Negocio:** Alto quando maduro — planejamento de estoque antecipado

**Quick Win:** Nao (precisa de historico maior)

---

### CATEGORIA 2: INTELIGENCIA DE ESTOQUE

---

**INSIGHT 2.1 — Taxa de Ruptura por SKU e Galpao (Stockout Rate)**

**Pergunta de Negocio:** Quais SKUs ficam sem estoque mais frequentemente em cada galpao? Onde estou perdendo dinheiro por falta de produto?

**Fontes de Dados:**
- `siso_pedido_item_estoques`: `produto_id`, `empresa_id`, `disponivel`, `saldo`, `reservado`
- `siso_pedido_itens`: `sku`, `pedido_id`, `compra_status`, `fornecedor_oc`
- `siso_empresas`: `id`, `nome`, `galpao_id`
- `siso_galpoes`: `id`, `nome`

**Abordagem SQL/Analitica:**
```sql
-- Taxa de ruptura: % de vezes que o SKU entrou como OC (sem estoque disponivel)
SELECT
  pi.sku,
  pi.descricao,
  g.nome AS galpao,
  COUNT(*) AS total_aparicoes,
  COUNT(*) FILTER (WHERE pie.disponivel = 0 OR pie.disponivel IS NULL) AS vezes_sem_estoque,
  COUNT(*) FILTER (WHERE pi.compra_status IS NOT NULL) AS vezes_em_oc,
  ROUND(
    COUNT(*) FILTER (WHERE pi.compra_status IS NOT NULL)::numeric /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS pct_ruptura
FROM siso_pedido_itens pi
JOIN siso_pedido_item_estoques pie ON pie.pedido_id = pi.pedido_id
  AND pie.produto_id = pi.produto_id
JOIN siso_empresas e ON e.id = pie.empresa_id
JOIN siso_galpoes g ON g.id = e.galpao_id
JOIN siso_pedidos p ON p.id = pi.pedido_id
WHERE p.status NOT IN ('cancelado')
GROUP BY pi.sku, pi.descricao, g.nome
HAVING COUNT(*) >= 5 -- apenas SKUs com volume relevante
ORDER BY pct_ruptura DESC
LIMIT 50;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — identifica diretamente quais produtos precisam de estoque urgente

**Quick Win:** Sim

---

**INSIGHT 2.2 — Estoque Morto e Giro Lento**

**Pergunta de Negocio:** Quais SKUs estamos comprando mas nao vendendo? Onde esta o capital imobilizado?

**Fontes de Dados:**
- `siso_inventario_itens`: `sku`, `quantidade`, `saldo_anterior_tiny`, `inventario_id`
- `siso_inventarios`: `empresa_id`, `concluido_em`
- `siso_pedido_itens`: `sku`, `quantidade_pedida`
- `siso_pedidos`: `criado_em`

**Abordagem SQL/Analitica:**
```sql
-- SKUs com saldo em inventario mas sem pedidos nos ultimos 21 dias
WITH demanda_recente AS (
  SELECT pi.sku, SUM(pi.quantidade_pedida) AS unidades_vendidas_21d
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE p.criado_em >= NOW() - INTERVAL '21 days'
    AND p.status NOT IN ('cancelado')
  GROUP BY pi.sku
),
ultimo_inventario AS (
  SELECT DISTINCT ON (ii.sku, e.galpao_id)
    ii.sku, ii.quantidade AS saldo_fisico, g.nome AS galpao,
    inv.concluido_em
  FROM siso_inventario_itens ii
  JOIN siso_inventarios inv ON inv.id = ii.inventario_id
  JOIN siso_empresas e ON e.id = inv.empresa_id
  JOIN siso_galpoes g ON g.id = e.galpao_id
  WHERE inv.status = 'concluido'
  ORDER BY ii.sku, e.galpao_id, inv.concluido_em DESC
)
SELECT
  ui.sku, ui.galpao, ui.saldo_fisico,
  COALESCE(dr.unidades_vendidas_21d, 0) AS vendas_21d,
  CASE
    WHEN COALESCE(dr.unidades_vendidas_21d, 0) = 0 THEN 'estoque_morto'
    WHEN ui.saldo_fisico / NULLIF(dr.unidades_vendidas_21d / 21.0, 0) > 90 THEN 'giro_muito_lento'
    WHEN ui.saldo_fisico / NULLIF(dr.unidades_vendidas_21d / 21.0, 0) > 30 THEN 'giro_lento'
    ELSE 'giro_normal'
  END AS classificacao
FROM ultimo_inventario ui
LEFT JOIN demanda_recente dr ON dr.sku = ui.sku
ORDER BY ui.saldo_fisico DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Alto — libera capital de giro e espaco fisico no galpao

**Quick Win:** Sim (se houver inventarios concluidos)

---

**INSIGHT 2.3 — Ponto de Reposicao Dinamico por SKU**

**Pergunta de Negocio:** Qual o estoque minimo que devo manter de cada SKU, considerando demanda media e lead time do fornecedor?

**Fontes de Dados:**
- `siso_pedido_itens`: `sku`, `quantidade_pedida`, `fornecedor_oc`, `compra_solicitada_em`, `recebido_em`
- `siso_pedidos`: `criado_em`
- `siso_inventario_itens`: `sku`, `quantidade`

**Abordagem SQL/Analitica:**
```sql
-- Calculo de ponto de reposicao: Demanda Media Diaria x Lead Time do Fornecedor + Safety Stock
WITH lead_times AS (
  SELECT
    pi.fornecedor_oc AS fornecedor,
    pi.sku,
    AVG(EXTRACT(EPOCH FROM (pi.recebido_em - pi.compra_solicitada_em)) / 3600) AS lead_time_horas_avg,
    STDDEV(EXTRACT(EPOCH FROM (pi.recebido_em - pi.compra_solicitada_em)) / 3600) AS lead_time_horas_std,
    COUNT(*) AS amostras
  FROM siso_pedido_itens pi
  WHERE pi.recebido_em IS NOT NULL AND pi.compra_solicitada_em IS NOT NULL
  GROUP BY pi.fornecedor_oc, pi.sku
),
demanda_diaria AS (
  SELECT
    pi.sku,
    SUM(pi.quantidade_pedida)::numeric /
    NULLIF(EXTRACT(DAY FROM NOW() - MIN(p.criado_em)), 0) AS demanda_diaria_avg
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE p.status NOT IN ('cancelado')
  GROUP BY pi.sku
)
SELECT
  lt.sku, lt.fornecedor,
  ROUND(lt.lead_time_horas_avg, 1) AS lead_time_horas_avg,
  ROUND(lt.lead_time_horas_std, 1) AS lead_time_horas_variabilidade,
  ROUND(dd.demanda_diaria_avg, 2) AS demanda_diaria_avg,
  -- Ponto de reposicao = Demanda_diaria * Lead_time_dias + Safety_stock (1.65 * sigma para 95% SL)
  ROUND(
    dd.demanda_diaria_avg * (lt.lead_time_horas_avg / 24.0) +
    1.65 * lt.lead_time_horas_std / 24.0 * dd.demanda_diaria_avg, 1
  ) AS ponto_reposicao_recomendado,
  lt.amostras
FROM lead_times lt
JOIN demanda_diaria dd ON dd.sku = lt.sku
WHERE lt.amostras >= 3
ORDER BY dd.demanda_diaria_avg DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Alto — elimina ruptura com estoque minimo justificado por dados

**Quick Win:** Sim (com pelo menos 3 semanas de historico de OCs)

---

**INSIGHT 2.4 — Falsos Negativos de Estoque (Decisao OC Desnecessaria)**

**Pergunta de Negocio:** Estou abrindo OC para produtos que na verdade tinha estoque fisico disponivel? Quanto isso custa?

**Fontes de Dados:**
- `siso_pedido_item_estoques`: `produto_id`, `empresa_id`, `disponivel` (snapshot no momento do pedido)
- `siso_pedido_itens`: `sku`, `compra_status`, `recebido_em`, `compra_solicitada_em`
- `siso_inventario_itens`: `sku`, `saldo_anterior_tiny` (balanco fisico posterior)

**Abordagem SQL/Analitica:**
```sql
-- Pedidos que foram para OC mas tinham saldo em inventario posterior
WITH ocs_abertas AS (
  SELECT
    pi.sku, pi.pedido_id, pi.compra_solicitada_em, pie.disponivel AS disponivel_snapshot
  FROM siso_pedido_itens pi
  JOIN siso_pedido_item_estoques pie ON pie.pedido_id = pi.pedido_id
    AND pie.produto_id = pi.produto_id
  WHERE pi.compra_status IS NOT NULL
    AND pie.disponivel = 0
),
inventario_pos AS (
  SELECT DISTINCT ON (ii.sku)
    ii.sku, ii.saldo_anterior_tiny, inv.concluido_em
  FROM siso_inventario_itens ii
  JOIN siso_inventarios inv ON inv.id = ii.inventario_id
  WHERE inv.status = 'concluido'
  ORDER BY ii.sku, inv.concluido_em ASC
)
SELECT
  o.sku, COUNT(*) AS ocs_possivelmente_desnecessarias,
  AVG(ip.saldo_anterior_tiny) AS saldo_fisico_no_inventario
FROM ocs_abertas o
JOIN inventario_pos ip ON ip.sku = o.sku
  AND ip.concluido_em > o.compra_solicitada_em
  AND ip.saldo_anterior_tiny > 0
GROUP BY o.sku
ORDER BY 2 DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Alto — elimina compras desnecessarias e reduz lead time de pedidos

**Quick Win:** Sim

---

**INSIGHT 2.5 — Otimizacao de Distribuicao de Estoque entre Galpoes**

**Pergunta de Negocio:** Quais SKUs devo duplicar nos dois galpoes para reduzir transferencias inter-galpao?

**Fontes de Dados:**
- `siso_pedidos`: `empresa_origem_id`, `decisao_final`, `separacao_galpao_id`
- `siso_pedido_itens`: `sku`, `empresa_deducao_id`
- `siso_transferencia_itens`: `sku`, `quantidade`

**Abordagem SQL/Analitica:**
```sql
-- SKUs que frequentemente viajam de um galpao para outro
SELECT
  pi.sku,
  pi.descricao,
  g_origem.nome AS galpao_pedido,
  g_sep.nome AS galpao_separacao,
  COUNT(*) AS transferencias_implicitas,
  SUM(pi.quantidade_pedida) AS unidades_transferidas
FROM siso_pedido_itens pi
JOIN siso_pedidos p ON p.id = pi.pedido_id
JOIN siso_empresas e_orig ON e_orig.id = p.empresa_origem_id
JOIN siso_galpoes g_origem ON g_origem.id = e_orig.galpao_id
LEFT JOIN siso_galpoes g_sep ON g_sep.id = p.separacao_galpao_id
WHERE p.decisao_final = 'transferencia'
  AND e_orig.galpao_id != p.separacao_galpao_id
  AND p.status NOT IN ('cancelado')
GROUP BY pi.sku, pi.descricao, g_origem.nome, g_sep.nome
HAVING COUNT(*) >= 3
ORDER BY 5 DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — reduz custo e lead time de transferencias

**Quick Win:** Sim

---

### CATEGORIA 3: DESEMPENHO DE FULFILLMENT

---

**INSIGHT 3.1 — Lead Time Total por Etapa e Canal**

**Pergunta de Negocio:** Onde o pedido passa mais tempo parado? Qual canal tem maior lead time?

**Fontes de Dados:**
- `siso_pedidos`: `criado_em`, `processado_em`, `separacao_iniciada_em`, `separacao_concluida_em`, `embalagem_concluida_em`, `nome_ecommerce`, `decisao_final`
- `siso_pedido_historico`: `pedido_id`, `evento`, `criado_em`

**Abordagem SQL/Analitica:**
```sql
-- Lead time por etapa em minutos
SELECT
  CASE
    WHEN LOWER(p.nome_ecommerce) LIKE '%mercado livre%' THEN 'Mercado Livre'
    WHEN LOWER(p.nome_ecommerce) LIKE '%shopee%' THEN 'Shopee'
    ELSE COALESCE(p.nome_ecommerce, 'Outros')
  END AS canal,
  p.decisao_final,
  COUNT(*) AS pedidos,
  -- Webhook → Processamento
  ROUND(AVG(EXTRACT(EPOCH FROM (p.processado_em - p.criado_em)) / 60), 1) AS min_webhook_a_processado,
  -- Processado → Inicio Separacao
  ROUND(AVG(EXTRACT(EPOCH FROM (p.separacao_iniciada_em - p.processado_em)) / 60), 1) AS min_fila_separacao,
  -- Inicio → Conclusao Separacao
  ROUND(AVG(EXTRACT(EPOCH FROM (p.separacao_concluida_em - p.separacao_iniciada_em)) / 60), 1) AS min_picking,
  -- Separacao → Embalagem
  ROUND(AVG(EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.separacao_concluida_em)) / 60), 1) AS min_embalagem,
  -- Total: Webhook ate Embalagem
  ROUND(AVG(EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em)) / 60), 1) AS min_total,
  -- P90
  ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em)) / 60), 1) AS p90_total
FROM siso_pedidos p
WHERE p.embalagem_concluida_em IS NOT NULL
  AND p.criado_em IS NOT NULL
  AND p.status NOT IN ('cancelado')
GROUP BY 1, 2
ORDER BY 9 DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — identifica gargalos objetivamente com dados

**Quick Win:** Sim

---

**INSIGHT 3.2 — Deteccao de Gargalo Dinamico no Pipeline**

**Pergunta de Negocio:** Qual etapa esta acumulando mais pedidos agora? Como isso varia ao longo do dia?

**Fontes de Dados:**
- `siso_pedidos`: `status_separacao`, `criado_em`, `separacao_iniciada_em`, `embalagem_concluida_em`
- `siso_pedido_historico`: `evento`, `criado_em`

**Abordagem SQL/Analitica:**
```sql
-- Tempo medio de permanencia em cada status (pedidos que JA saíram do status)
WITH transicoes AS (
  SELECT
    h1.pedido_id,
    h1.evento AS evento_entrada,
    h1.criado_em AS entrada_em,
    MIN(h2.criado_em) AS saida_em
  FROM siso_pedido_historico h1
  LEFT JOIN siso_pedido_historico h2 ON h2.pedido_id = h1.pedido_id
    AND h2.criado_em > h1.criado_em
  GROUP BY h1.pedido_id, h1.evento, h1.criado_em
)
SELECT
  evento_entrada,
  COUNT(*) AS transicoes,
  ROUND(AVG(EXTRACT(EPOCH FROM (saida_em - entrada_em)) / 60), 1) AS tempo_medio_min,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (saida_em - entrada_em)) / 60), 1) AS mediana_min,
  ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (saida_em - entrada_em)) / 60), 1) AS p90_min
FROM transicoes
WHERE saida_em IS NOT NULL
GROUP BY 1
ORDER BY 4 DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Alto — apontar gargalo para gestor com dado objetivo

**Quick Win:** Sim

---

**INSIGHT 3.3 — Taxa de Atendimento no Prazo por Canal**

**Pergunta de Negocio:** Qual percentual de pedidos do Mercado Livre estamos expedindo dentro do prazo? Estamos em risco de penalizacao?

**Fontes de Dados:**
- `siso_pedidos`: `prazo_envio`, `embalagem_concluida_em`, `nome_ecommerce`, `status`

**Abordagem SQL/Analitica:**
```sql
SELECT
  CASE
    WHEN LOWER(nome_ecommerce) LIKE '%mercado livre%' THEN 'Mercado Livre'
    WHEN LOWER(nome_ecommerce) LIKE '%shopee%' THEN 'Shopee'
    WHEN LOWER(nome_ecommerce) LIKE '%amazon%' THEN 'Amazon'
    WHEN LOWER(nome_ecommerce) LIKE '%magalu%' THEN 'Magalu'
    ELSE 'Outros'
  END AS canal,
  COUNT(*) AS total_com_prazo,
  COUNT(*) FILTER (WHERE embalagem_concluida_em <= prazo_envio) AS dentro_prazo,
  COUNT(*) FILTER (WHERE embalagem_concluida_em > prazo_envio) AS atrasados,
  COUNT(*) FILTER (WHERE embalagem_concluida_em IS NULL AND prazo_envio < NOW()) AS nao_expedidos_atrasados,
  ROUND(
    COUNT(*) FILTER (WHERE embalagem_concluida_em <= prazo_envio)::numeric /
    NULLIF(COUNT(*) FILTER (WHERE embalagem_concluida_em IS NOT NULL), 0) * 100, 1
  ) AS pct_no_prazo,
  ROUND(AVG(
    EXTRACT(EPOCH FROM (prazo_envio - embalagem_concluida_em)) / 60
  ) FILTER (WHERE embalagem_concluida_em IS NOT NULL), 0) AS slack_medio_min
FROM siso_pedidos
WHERE prazo_envio IS NOT NULL
  AND status NOT IN ('cancelado')
GROUP BY 1
ORDER BY pct_no_prazo ASC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — SLA de marketplace diretamente vinculado a reputacao do vendedor

**Quick Win:** Sim

---

**INSIGHT 3.4 — Taxa de Auto-Aprovacao e Acuracia da Sugestao do Sistema**

**Pergunta de Negocio:** O sistema esta sugerindo a decisao certa? Quando o operador muda a sugestao, qual e a decisao alternativa mais frequente?

**Fontes de Dados:**
- `siso_pedidos`: `sugestao`, `decisao_final`, `tipo_resolucao`, `operador_nome`

**Abordagem SQL/Analitica:**
```sql
-- Concordancia entre sugestao do sistema e decisao do operador
SELECT
  sugestao,
  decisao_final,
  tipo_resolucao,
  COUNT(*) AS total,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER (PARTITION BY sugestao) * 100, 1) AS pct_desta_decisao
FROM siso_pedidos
WHERE sugestao IS NOT NULL AND decisao_final IS NOT NULL
  AND status NOT IN ('cancelado')
GROUP BY 1, 2, 3
ORDER BY 1, 4 DESC;

-- Taxa de concordancia global
SELECT
  ROUND(
    COUNT(*) FILTER (WHERE sugestao = decisao_final)::numeric / COUNT(*) * 100, 1
  ) AS pct_concordancia,
  COUNT(*) FILTER (WHERE tipo_resolucao = 'auto') AS auto_aprovados,
  COUNT(*) FILTER (WHERE tipo_resolucao = 'manual') AS revisados_manual,
  COUNT(*) AS total
FROM siso_pedidos
WHERE sugestao IS NOT NULL AND decisao_final IS NOT NULL;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — mede a qualidade do sistema e identifica oportunidades de expandir auto-aprovacao

**Quick Win:** Sim

---

**INSIGHT 3.5 — Throughput por Turno e Dia da Semana**

**Pergunta de Negocio:** Qual o pico de capacidade do galpao? Segunda-feira e realmente mais lenta que sexta?

**Fontes de Dados:**
- `siso_pedidos`: `embalagem_concluida_em`, `separacao_galpao_id`, `separacao_operador_id`

**Abordagem SQL/Analitica:**
```sql
SELECT
  g.nome AS galpao,
  EXTRACT(DOW FROM embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo') AS dia_semana,
  EXTRACT(HOUR FROM embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo') AS hora,
  COUNT(*) AS pedidos_embalados,
  ROUND(AVG(COUNT(*)) OVER (
    PARTITION BY separacao_galpao_id,
    EXTRACT(DOW FROM embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo'),
    EXTRACT(HOUR FROM embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo')
  ), 1) AS media_historica
FROM siso_pedidos p
JOIN siso_galpoes g ON g.id = p.separacao_galpao_id
WHERE embalagem_concluida_em IS NOT NULL
GROUP BY g.nome, p.separacao_galpao_id, 2, 3
ORDER BY dia_semana, hora;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — escalonamento mais preciso de operadores

**Quick Win:** Sim

---

### CATEGORIA 4: OTIMIZACAO DE COMPRAS

---

**INSIGHT 4.1 — Lead Time Real por Fornecedor (Interno + Externo)**

**Pergunta de Negocio:** Quanto tempo cada fornecedor leva realmente para entregar? Meu comprador esta demorando demais para abrir a OC?

**Fontes de Dados:**
- `siso_pedido_itens`: `fornecedor_oc`, `compra_solicitada_em`, `comprado_em`, `recebido_em`, `compra_status`
- `siso_ordens_compra`: `fornecedor`, `comprado_em`, `status`

**Abordagem SQL/Analitica:**
```sql
SELECT
  pi.fornecedor_oc AS fornecedor,
  COUNT(*) FILTER (WHERE pi.recebido_em IS NOT NULL) AS itens_recebidos,
  -- Lead time interno: solicitacao ate compra (responsabilidade do comprador)
  ROUND(AVG(EXTRACT(EPOCH FROM (pi.comprado_em - pi.compra_solicitada_em)) / 3600)
    FILTER (WHERE pi.comprado_em IS NOT NULL AND pi.compra_solicitada_em IS NOT NULL), 1)
    AS lead_interno_horas_avg,
  ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (pi.comprado_em - pi.compra_solicitada_em)) / 3600
  ) FILTER (WHERE pi.comprado_em IS NOT NULL AND pi.compra_solicitada_em IS NOT NULL), 1)
    AS lead_interno_horas_p90,
  -- Lead time externo: compra ate recebimento (responsabilidade do fornecedor)
  ROUND(AVG(EXTRACT(EPOCH FROM (pi.recebido_em - pi.comprado_em)) / 3600)
    FILTER (WHERE pi.recebido_em IS NOT NULL AND pi.comprado_em IS NOT NULL), 1)
    AS lead_externo_horas_avg,
  ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (pi.recebido_em - pi.comprado_em)) / 3600
  ) FILTER (WHERE pi.recebido_em IS NOT NULL AND pi.comprado_em IS NOT NULL), 1)
    AS lead_externo_horas_p90,
  -- Total
  ROUND(AVG(EXTRACT(EPOCH FROM (pi.recebido_em - pi.compra_solicitada_em)) / 3600)
    FILTER (WHERE pi.recebido_em IS NOT NULL AND pi.compra_solicitada_em IS NOT NULL), 1)
    AS lead_total_horas_avg
FROM siso_pedido_itens pi
WHERE pi.fornecedor_oc IS NOT NULL
GROUP BY pi.fornecedor_oc
ORDER BY lead_total_horas_avg DESC NULLS LAST;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — separar ineficiencia interna de externa, SLA com fornecedores

**Quick Win:** Sim

---

**INSIGHT 4.2 — Agrupamento de Itens OC por Janela de Tempo (Compra em Lote)**

**Pergunta de Negocio:** Posso agrupar multiplos pedidos OC do mesmo fornecedor numa unica compra? Quantas compras estou fazendo que poderiam ser consolidadas?

**Fontes de Dados:**
- `siso_pedido_itens`: `sku`, `fornecedor_oc`, `compra_solicitada_em`, `quantidade_pedida`, `pedido_id`
- `siso_pedidos`: `criado_em`

**Abordagem SQL/Analitica:**
```sql
-- Oportunidades de agrupamento: itens OC do mesmo fornecedor em janela de 4 horas
WITH ocs_por_fornecedor AS (
  SELECT
    pi.fornecedor_oc,
    pi.sku,
    pi.compra_solicitada_em,
    pi.quantidade_pedida,
    DATE_TRUNC('hour', pi.compra_solicitada_em) +
      INTERVAL '4 hours' * (EXTRACT(HOUR FROM pi.compra_solicitada_em)::int / 4)
    AS janela_4h
  FROM siso_pedido_itens pi
  WHERE pi.compra_status IS NOT NULL AND pi.fornecedor_oc IS NOT NULL
)
SELECT
  fornecedor_oc, janela_4h,
  COUNT(DISTINCT sku) AS skus_distintos,
  COUNT(*) AS itens_totais,
  SUM(quantidade_pedida) AS unidades_totais,
  COUNT(DISTINCT pedido_id) AS pedidos_origem
FROM ocs_por_fornecedor oc
JOIN siso_pedido_itens pi USING (fornecedor_oc, sku, compra_solicitada_em)
GROUP BY 1, 2
HAVING COUNT(DISTINCT sku) > 1  -- so janelas com oportunidade de agrupamento
ORDER BY itens_totais DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Medio — reduz numero de OCs, possibilita desconto por volume

**Quick Win:** Sim

---

**INSIGHT 4.3 — Padroes de Equivalencia de Produtos**

**Pergunta de Negocio:** Quando uso um produto equivalente, qual e a taxa de aceitacao? Quais equivalencias sao mais confiavel?

**Fontes de Dados:**
- `siso_pedido_itens`: `sku`, `compra_equivalente_sku`, `compra_equivalente_fornecedor`, `compra_status`, `pedido_id`
- `siso_pedidos`: `status`

**Abordagem SQL/Analitica:**
```sql
-- Analise de equivalencias utilizadas
SELECT
  pi.sku AS sku_original,
  pi.compra_equivalente_sku AS sku_equivalente,
  pi.compra_equivalente_fornecedor AS fornecedor_equiv,
  COUNT(*) AS vezes_usada,
  COUNT(*) FILTER (WHERE pi.compra_status IN ('recebido')) AS vezes_recebido,
  COUNT(*) FILTER (WHERE pi.compra_status IN ('cancelado', 'indisponivel')) AS vezes_cancelado,
  ROUND(
    COUNT(*) FILTER (WHERE pi.compra_status = 'recebido')::numeric /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS taxa_sucesso_pct
FROM siso_pedido_itens pi
WHERE pi.compra_equivalente_sku IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY vezes_usada DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — base para biblioteca de equivalencias confiavel

**Quick Win:** Sim

---

**INSIGHT 4.4 — Score de Risco de OC por Prazo de Envio**

**Pergunta de Negocio:** Quais OCs abertas hoje tem risco de nao ser recebidas a tempo do prazo de envio do marketplace?

**Fontes de Dados:**
- `siso_pedido_itens`: `pedido_id`, `fornecedor_oc`, `compra_status`, `compra_solicitada_em`
- `siso_pedidos`: `prazo_envio`, `status_separacao`, `nome_ecommerce`

**Abordagem SQL/Analitica:**
```sql
-- Pedidos em aguardando_compra com risco de atraso
WITH lead_times_medios AS (
  SELECT
    fornecedor_oc,
    AVG(EXTRACT(EPOCH FROM (recebido_em - compra_solicitada_em)) / 3600) AS lead_medio_horas
  FROM siso_pedido_itens
  WHERE recebido_em IS NOT NULL AND compra_solicitada_em IS NOT NULL
  GROUP BY fornecedor_oc
)
SELECT
  p.id AS pedido_id,
  p.numero,
  p.nome_ecommerce,
  p.prazo_envio,
  pi.fornecedor_oc,
  pi.compra_solicitada_em,
  lm.lead_medio_horas,
  pi.compra_solicitada_em + (lm.lead_medio_horas || ' hours')::INTERVAL AS eta_estimado,
  ROUND(EXTRACT(EPOCH FROM (p.prazo_envio - NOW())) / 3600, 1) AS horas_ate_prazo,
  CASE
    WHEN pi.compra_solicitada_em + (lm.lead_medio_horas || ' hours')::INTERVAL > p.prazo_envio
    THEN 'RISCO_ALTO'
    WHEN p.prazo_envio < NOW() + INTERVAL '8 hours'
    THEN 'URGENTE'
    ELSE 'OK'
  END AS status_risco
FROM siso_pedidos p
JOIN siso_pedido_itens pi ON pi.pedido_id = p.id
  AND pi.compra_status IN ('aguardando_compra', 'comprado')
LEFT JOIN lead_times_medios lm ON lm.fornecedor_oc = pi.fornecedor_oc
WHERE p.status_separacao = 'aguardando_compra'
  AND p.prazo_envio IS NOT NULL
ORDER BY p.prazo_envio ASC;
```

**Complexidade:** Media

**Impacto de Negocio:** Muito Alto — previne penalizacoes de marketplace antes que acontecam

**Quick Win:** Sim

---

**INSIGHT 4.5 — Desempenho do Comprador por Volume e Velocidade**

**Pergunta de Negocio:** Qual comprador e mais rapido para abrir OCs? Ha diferenca de desempenho entre compradores?

**Fontes de Dados:**
- `siso_ordens_compra`: `comprado_por`, `comprado_em`, `fornecedor`, `status`
- `siso_pedido_itens`: `comprado_por`, `compra_solicitada_em`, `comprado_em`, `fornecedor_oc`
- `siso_usuarios`: `id`, `nome`

**Abordagem SQL/Analitica:**
```sql
SELECT
  u.nome AS comprador,
  COUNT(*) AS itens_comprados,
  COUNT(DISTINCT pi.ordem_compra_id) AS ocs_abertas,
  COUNT(DISTINCT pi.fornecedor_oc) AS fornecedores_distintos,
  ROUND(AVG(EXTRACT(EPOCH FROM (pi.comprado_em - pi.compra_solicitada_em)) / 60), 0) AS tempo_medio_resposta_min,
  ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (pi.comprado_em - pi.compra_solicitada_em)) / 60
  ), 0) AS p90_resposta_min
FROM siso_pedido_itens pi
JOIN siso_usuarios u ON u.id = pi.comprado_por
WHERE pi.comprado_em IS NOT NULL AND pi.compra_solicitada_em IS NOT NULL
GROUP BY u.nome
ORDER BY tempo_medio_resposta_min ASC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — identificar necessidade de treinamento ou redistribuicao de carga

**Quick Win:** Sim

---

### CATEGORIA 5: ANALYTICS DE OPERADORES

---

**INSIGHT 5.1 — Produtividade de Separacao por Operador**

**Pergunta de Negocio:** Qual operador separa mais pedidos por hora? Ha diferenca significativa entre os melhores e piores?

**Fontes de Dados:**
- `siso_pedidos`: `separacao_operador_id`, `separacao_iniciada_em`, `separacao_concluida_em`, `separacao_galpao_id`
- `siso_pedido_itens`: `pedido_id`, `quantidade_pedida`, `bipado_por`
- `siso_usuarios`: `id`, `nome`

**Abordagem SQL/Analitica:**
```sql
-- Produtividade por operador: pedidos/hora e itens/hora
SELECT
  u.nome AS operador,
  g.nome AS galpao,
  COUNT(DISTINCT p.id) AS pedidos_separados,
  SUM(pi.quantidade_pedida) AS itens_bipados_total,
  ROUND(AVG(EXTRACT(EPOCH FROM (p.separacao_concluida_em - p.separacao_iniciada_em)) / 60), 1)
    AS tempo_medio_picking_min,
  -- Itens por hora de picking ativo
  ROUND(
    SUM(pi.quantidade_pedida)::numeric /
    NULLIF(SUM(EXTRACT(EPOCH FROM (p.separacao_concluida_em - p.separacao_iniciada_em)) / 3600), 0),
    1
  ) AS itens_por_hora,
  -- Pedidos por hora de picking ativo
  ROUND(
    COUNT(DISTINCT p.id)::numeric /
    NULLIF(SUM(EXTRACT(EPOCH FROM (p.separacao_concluida_em - p.separacao_iniciada_em)) / 3600), 0),
    1
  ) AS pedidos_por_hora
FROM siso_pedidos p
JOIN siso_pedido_itens pi ON pi.pedido_id = p.id
JOIN siso_usuarios u ON u.id = p.separacao_operador_id
JOIN siso_galpoes g ON g.id = p.separacao_galpao_id
WHERE p.separacao_concluida_em IS NOT NULL
  AND p.separacao_iniciada_em IS NOT NULL
  AND p.status NOT IN ('cancelado')
GROUP BY u.nome, g.nome
ORDER BY itens_por_hora DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — benchmarking e identificacao de necessidades de treinamento

**Quick Win:** Sim

---

**INSIGHT 5.2 — Curva de Aprendizado de Novos Operadores**

**Pergunta de Negocio:** Quanto tempo um novo operador leva para atingir a produtividade dos mais experientes?

**Fontes de Dados:**
- `siso_pedidos`: `separacao_operador_id`, `separacao_iniciada_em`, `separacao_concluida_em`
- `siso_usuarios`: `id`, `nome`, `criado_em` (proxy para data de contratacao)

**Abordagem SQL/Analitica:**
```sql
-- Produtividade por operador ao longo do tempo (semanas desde primeiro pedido)
WITH primeira_separacao AS (
  SELECT separacao_operador_id, MIN(separacao_iniciada_em) AS primeira_vez
  FROM siso_pedidos
  WHERE separacao_iniciada_em IS NOT NULL
  GROUP BY separacao_operador_id
),
performance_semanal AS (
  SELECT
    p.separacao_operador_id,
    FLOOR(EXTRACT(EPOCH FROM (p.separacao_iniciada_em - ps.primeira_vez)) / (7 * 86400))::int AS semana_desde_inicio,
    AVG(EXTRACT(EPOCH FROM (p.separacao_concluida_em - p.separacao_iniciada_em)) / 60) AS tempo_medio_min
  FROM siso_pedidos p
  JOIN primeira_separacao ps ON ps.separacao_operador_id = p.separacao_operador_id
  WHERE p.separacao_concluida_em IS NOT NULL
  GROUP BY p.separacao_operador_id, 2
)
SELECT
  u.nome,
  ps.semana_desde_inicio,
  ROUND(ps.tempo_medio_min::numeric, 1) AS tempo_medio_picking_min
FROM performance_semanal ps
JOIN siso_usuarios u ON u.id = ps.separacao_operador_id
ORDER BY u.nome, ps.semana_desde_inicio;
```

**Complexidade:** Media

**Impacto de Negocio:** Medio — planejar tempo de onboarding e meta de rampagem

**Quick Win:** Sim

---

**INSIGHT 5.3 — Analise de Erros de Bipagem por Operador**

**Pergunta de Negocio:** Algum operador comete mais erros durante o picking (bips desfeitos, itens marcados errado)?

**Fontes de Dados:**
- `siso_pedido_historico`: `evento`, `usuario_id`, `usuario_nome`, `criado_em`
- Eventos relevantes: `item_separado`, `desfazer_bip`, `separacao_reiniciada`

**Abordagem SQL/Analitica:**
```sql
-- Taxa de erros por operador (bips desfeitos / total de bips)
SELECT
  h.usuario_nome AS operador,
  COUNT(*) FILTER (WHERE h.evento = 'item_separado') AS bips_realizados,
  COUNT(*) FILTER (WHERE h.evento LIKE '%desfazer%' OR h.evento LIKE '%reiniciar%') AS bips_desfeitos,
  ROUND(
    COUNT(*) FILTER (WHERE h.evento LIKE '%desfazer%' OR h.evento LIKE '%reiniciar%')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE h.evento = 'item_separado'), 0) * 100, 2
  ) AS taxa_erro_pct
FROM siso_pedido_historico h
WHERE h.usuario_nome IS NOT NULL
  AND h.evento IN ('item_separado', 'desfazer_bip', 'separacao_reiniciada', 'status_revertido')
GROUP BY h.usuario_nome
ORDER BY taxa_erro_pct DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — identificar necessidade de treinamento e reducao de retrabalho

**Quick Win:** Sim

---

**INSIGHT 5.4 — Workload Diario Efetivo vs Capacidade Instalada**

**Pergunta de Negocio:** Estamos operando perto do limite de capacidade? Em que dias precisamos de hora extra?

**Fontes de Dados:**
- `siso_pedidos`: `separacao_operador_id`, `separacao_galpao_id`, `embalagem_concluida_em`
- `siso_usuarios`: `id`, `nome`, `cargo`

**Abordagem SQL/Analitica:**
```sql
-- Pedidos por operador por dia
SELECT
  DATE(p.embalagem_concluida_em AT TIME ZONE 'America/Sao_Paulo') AS dia,
  g.nome AS galpao,
  COUNT(DISTINCT p.separacao_operador_id) AS operadores_ativos,
  COUNT(*) AS pedidos_embalados,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT p.separacao_operador_id), 0), 1)
    AS pedidos_por_operador
FROM siso_pedidos p
JOIN siso_galpoes g ON g.id = p.separacao_galpao_id
WHERE p.embalagem_concluida_em IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — gestao de escala e previsao de overtime

**Quick Win:** Sim

---

### CATEGORIA 6: INSIGHTS FINANCEIROS

---

**INSIGHT 6.1 — Custo de Ruptura: O Quanto a Falta de Estoque Esta Custando**

**Pergunta de Negocio:** Qual e o custo total estimado de pedidos que foram para OC em vez de atendimento imediato? (inclui risco de cancelamento e penalizacao de marketplace)

**Fontes de Dados:**
- `siso_pedidos`: `decisao_final`, `criado_em`, `prazo_envio`, `nome_ecommerce`, `status`
- `siso_pedido_itens`: `compra_status`, `fornecedor_oc`, `compra_solicitada_em`, `recebido_em`

**Abordagem SQL/Analitica:**
```sql
-- Pedidos OC: taxa de conversao para atendimento vs cancelamento
SELECT
  DATE_TRUNC('week', p.criado_em) AS semana,
  COUNT(*) FILTER (WHERE p.decisao_final = 'oc') AS pedidos_oc,
  COUNT(*) FILTER (WHERE p.decisao_final = 'oc' AND p.status = 'concluido') AS oc_concluidos,
  COUNT(*) FILTER (WHERE p.decisao_final = 'oc' AND p.status = 'cancelado') AS oc_cancelados,
  ROUND(
    COUNT(*) FILTER (WHERE p.decisao_final = 'oc' AND p.status = 'cancelado')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE p.decisao_final = 'oc'), 0) * 100, 1
  ) AS pct_oc_cancelada,
  -- Lead time adicional que OC adiciona vs propria
  ROUND(AVG(EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em)) / 60)
    FILTER (WHERE p.decisao_final = 'oc' AND p.embalagem_concluida_em IS NOT NULL), 0)
    AS lead_time_oc_min,
  ROUND(AVG(EXTRACT(EPOCH FROM (p.embalagem_concluida_em - p.criado_em)) / 60)
    FILTER (WHERE p.decisao_final = 'propria' AND p.embalagem_concluida_em IS NOT NULL), 0)
    AS lead_time_propria_min
FROM siso_pedidos p
GROUP BY 1
ORDER BY 1;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — quantificar custo de decisao OC vs investimento em estoque

**Quick Win:** Sim

---

**INSIGHT 6.2 — ROI da Politica de Auto-Aprovacao**

**Pergunta de Negocio:** Pedidos auto-aprovados tem melhor lead time e menor taxa de cancelamento que pedidos aprovados manualmente?

**Fontes de Dados:**
- `siso_pedidos`: `tipo_resolucao`, `decisao_final`, `status`, `criado_em`, `embalagem_concluida_em`, `prazo_envio`

**Abordagem SQL/Analitica:**
```sql
SELECT
  tipo_resolucao,
  decisao_final,
  COUNT(*) AS total_pedidos,
  COUNT(*) FILTER (WHERE status = 'cancelado') AS cancelados,
  ROUND(COUNT(*) FILTER (WHERE status = 'cancelado')::numeric / COUNT(*) * 100, 1) AS pct_cancelado,
  ROUND(AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - criado_em)) / 60)
    FILTER (WHERE embalagem_concluida_em IS NOT NULL), 0) AS lead_time_medio_min,
  -- Pedidos com prazo: % entregue no prazo
  ROUND(
    COUNT(*) FILTER (WHERE embalagem_concluida_em <= prazo_envio)::numeric /
    NULLIF(COUNT(*) FILTER (WHERE prazo_envio IS NOT NULL AND embalagem_concluida_em IS NOT NULL), 0) * 100, 1
  ) AS pct_no_prazo
FROM siso_pedidos
WHERE tipo_resolucao IS NOT NULL
GROUP BY tipo_resolucao, decisao_final
ORDER BY tipo_resolucao, lead_time_medio_min;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — base para expandir criterios de auto-aprovacao com seguranca

**Quick Win:** Sim

---

**INSIGHT 6.3 — Concentracao de Faturamento: Regra 80/20 por SKU**

**Pergunta de Negocio:** Quais 20% dos SKUs respondem por 80% do volume de pedidos? Esses SKUs estao tendo ruptura de estoque?

**Fontes de Dados:**
- `siso_pedido_itens`: `sku`, `descricao`, `quantidade_pedida`, `compra_status`
- `siso_pedidos`: `criado_em`, `status`

**Abordagem SQL/Analitica:**
```sql
WITH volume_por_sku AS (
  SELECT
    pi.sku, pi.descricao,
    SUM(pi.quantidade_pedida) AS total_unidades,
    COUNT(DISTINCT pi.pedido_id) AS total_pedidos,
    COUNT(*) FILTER (WHERE pi.compra_status IS NOT NULL) AS vezes_em_oc
  FROM siso_pedido_itens pi
  JOIN siso_pedidos p ON p.id = pi.pedido_id
  WHERE p.status NOT IN ('cancelado')
  GROUP BY pi.sku, pi.descricao
),
ranking AS (
  SELECT *,
    SUM(total_unidades) OVER () AS grand_total,
    SUM(total_unidades) OVER (ORDER BY total_unidades DESC) AS cumulativo,
    ROW_NUMBER() OVER (ORDER BY total_unidades DESC) AS ranking
  FROM volume_por_sku
)
SELECT
  sku, descricao, ranking, total_unidades, total_pedidos,
  ROUND(total_unidades::numeric / grand_total * 100, 2) AS pct_volume,
  ROUND(cumulativo::numeric / grand_total * 100, 1) AS pct_acumulado,
  CASE
    WHEN cumulativo::numeric / grand_total <= 0.8 THEN 'A (top 80%)'
    WHEN cumulativo::numeric / grand_total <= 0.95 THEN 'B (80-95%)'
    ELSE 'C (cauda longa)'
  END AS curva_abc,
  ROUND(vezes_em_oc::numeric / NULLIF(total_pedidos, 0) * 100, 1) AS pct_ruptura
FROM ranking
ORDER BY ranking;
```

**Complexidade:** Media

**Impacto de Negocio:** Alto — foco de investimento em estoque onde realmente importa

**Quick Win:** Sim

---

**INSIGHT 6.4 — Custo de Transferencias Inter-Galpao**

**Pergunta de Negocio:** Quanto estamos gastando em logistica de transferencia CWB-SP? Quais SKUs justificam duplicacao de estoque?

**Fontes de Dados:**
- `siso_transferencias`: `empresa_origem_id`, `empresa_destino_id`, `concluido_em`
- `siso_transferencia_itens`: `sku`, `quantidade`
- `siso_pedidos`: `decisao_final`, `empresa_origem_id`, `separacao_galpao_id`

**Abordagem SQL/Analitica:**
```sql
-- Frequencia de transferencia por SKU
SELECT
  ti.sku,
  g_orig.nome AS origem,
  g_dest.nome AS destino,
  COUNT(*) AS n_transferencias,
  SUM(ti.quantidade) AS unidades_transferidas,
  -- Frequencia mensal projetada (com base em 3 semanas de historico)
  ROUND(COUNT(*)::numeric / 3 * 4, 1) AS freq_mensal_projetada,
  -- SKUs que transferem frequentemente E tem alta demanda = candidatos a duplicacao
  DENSE_RANK() OVER (ORDER BY COUNT(*) DESC) AS rank_transferencia
FROM siso_transferencia_itens ti
JOIN siso_transferencias t ON t.id = ti.transferencia_id
JOIN siso_empresas e_orig ON e_orig.id = t.empresa_origem_id
JOIN siso_galpoes g_orig ON g_orig.id = e_orig.galpao_id
JOIN siso_empresas e_dest ON e_dest.id = t.empresa_destino_id
JOIN siso_galpoes g_dest ON g_dest.id = e_dest.galpao_id
WHERE t.status = 'concluido'
GROUP BY ti.sku, g_orig.nome, g_dest.nome
ORDER BY n_transferencias DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio-Alto — decisao de duplicacao de estoque justificada por dados

**Quick Win:** Sim

---

### CATEGORIA 7: ANALYTICS DE CLIENTES E CANAIS

---

**INSIGHT 7.1 — Clientes Recorrentes e Perfil de Compra**

**Pergunta de Negocio:** Quais clientes compram mais vezes? Eles tendem a pedir os mesmos SKUs ou SKUs complementares?

**Fontes de Dados:**
- `siso_pedidos`: `cliente_cpf_cnpj`, `cliente_nome`, `criado_em`, `nome_ecommerce`, `decisao_final`
- `siso_pedido_itens`: `sku`, `descricao`, `quantidade_pedida`, `pedido_id`

**Abordagem SQL/Analitica:**
```sql
-- Clientes recorrentes e seus padrao de compra
SELECT
  p.cliente_cpf_cnpj,
  p.cliente_nome,
  COUNT(DISTINCT p.id) AS total_pedidos,
  COUNT(DISTINCT pi.sku) AS skus_distintos,
  SUM(pi.quantidade_pedida) AS total_itens,
  MIN(p.criado_em) AS primeiro_pedido,
  MAX(p.criado_em) AS ultimo_pedido,
  ROUND(AVG(EXTRACT(EPOCH FROM (p.prazo_envio - p.criado_em)) / 3600), 1) AS slack_prazo_horas_avg,
  ARRAY_AGG(DISTINCT p.nome_ecommerce) AS canais_usados,
  -- Identificar clientes B2B (CNPJ vs CPF)
  CASE WHEN LENGTH(REGEXP_REPLACE(p.cliente_cpf_cnpj, '\D', '', 'g')) = 14
    THEN 'PJ' ELSE 'PF' END AS tipo_cliente
FROM siso_pedidos p
JOIN siso_pedido_itens pi ON pi.pedido_id = p.id
WHERE p.cliente_cpf_cnpj IS NOT NULL
  AND p.status NOT IN ('cancelado')
GROUP BY p.cliente_cpf_cnpj, p.cliente_nome
HAVING COUNT(DISTINCT p.id) >= 2
ORDER BY total_pedidos DESC
LIMIT 100;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — identificar clientes B2B para tratamento prioritario

**Quick Win:** Sim

---

**INSIGHT 7.2 — Afinity de Canal por SKU**

**Pergunta de Negocio:** Cada SKU tem predominancia em qual marketplace? Isso afeta a urgencia de separacao?

**Fontes de Dados:**
- `siso_pedidos`: `nome_ecommerce`, `prazo_envio`, `criado_em`
- `siso_pedido_itens`: `sku`, `pedido_id`

**Abordagem SQL/Analitica:**
```sql
SELECT
  pi.sku,
  CASE
    WHEN LOWER(p.nome_ecommerce) LIKE '%mercado livre%' THEN 'Mercado Livre'
    WHEN LOWER(p.nome_ecommerce) LIKE '%shopee%' THEN 'Shopee'
    WHEN LOWER(p.nome_ecommerce) LIKE '%amazon%' THEN 'Amazon'
    WHEN LOWER(p.nome_ecommerce) LIKE '%magalu%' THEN 'Magalu'
    ELSE 'Outros'
  END AS canal,
  COUNT(*) AS pedidos,
  ROUND(AVG(EXTRACT(EPOCH FROM (p.prazo_envio - p.criado_em)) / 3600), 1) AS slack_prazo_horas_avg,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER (PARTITION BY pi.sku) * 100, 1) AS pct_do_canal
FROM siso_pedido_itens pi
JOIN siso_pedidos p ON p.id = pi.pedido_id
WHERE p.prazo_envio IS NOT NULL AND p.status NOT IN ('cancelado')
GROUP BY pi.sku, 2
ORDER BY pi.sku, pedidos DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — definir prioridade de separacao por SKU+canal automaticamente

**Quick Win:** Sim

---

**INSIGHT 7.3 — Analise de Forma de Envio por Canal**

**Pergunta de Negocio:** Quais formas de envio geram mais atrasos? Transportadoras com prazos mais apertados exigem prioridade maior?

**Fontes de Dados:**
- `siso_pedidos`: `forma_envio_descricao`, `prazo_envio`, `embalagem_concluida_em`, `nome_ecommerce`, `status`

**Abordagem SQL/Analitica:**
```sql
SELECT
  forma_envio_descricao,
  CASE
    WHEN LOWER(nome_ecommerce) LIKE '%mercado livre%' THEN 'Mercado Livre'
    ELSE COALESCE(nome_ecommerce, 'Outros')
  END AS canal,
  COUNT(*) AS pedidos,
  ROUND(AVG(EXTRACT(EPOCH FROM (prazo_envio - criado_em)) / 3600), 1) AS janela_media_horas,
  ROUND(
    COUNT(*) FILTER (WHERE embalagem_concluida_em <= prazo_envio)::numeric /
    NULLIF(COUNT(*) FILTER (WHERE embalagem_concluida_em IS NOT NULL AND prazo_envio IS NOT NULL), 0) * 100, 1
  ) AS pct_no_prazo
FROM siso_pedidos
WHERE status NOT IN ('cancelado')
  AND forma_envio_descricao IS NOT NULL
GROUP BY 1, 2
HAVING COUNT(*) >= 5
ORDER BY janela_media_horas ASC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — descobrir formas de envio que exigem prioridade especial

**Quick Win:** Sim

---

**INSIGHT 7.4 — Concentracao de Volume por Canal ao Longo do Tempo**

**Pergunta de Negocio:** A participacao do Mercado Livre esta crescendo ou decaindo? Shopee esta ganhando share? Isso afeta nossa estrategia de estoque?

**Fontes de Dados:**
- `siso_pedidos`: `nome_ecommerce`, `criado_em`, `empresa_origem_id`

**Abordagem SQL/Analitica:**
```sql
SELECT
  DATE_TRUNC('week', criado_em AT TIME ZONE 'America/Sao_Paulo') AS semana,
  CASE
    WHEN LOWER(nome_ecommerce) LIKE '%mercado livre%' THEN 'Mercado Livre'
    WHEN LOWER(nome_ecommerce) LIKE '%shopee%' THEN 'Shopee'
    WHEN LOWER(nome_ecommerce) LIKE '%amazon%' THEN 'Amazon'
    WHEN LOWER(nome_ecommerce) LIKE '%magalu%' THEN 'Magalu'
    ELSE 'Outros'
  END AS canal,
  COUNT(*) AS pedidos,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER (
    PARTITION BY DATE_TRUNC('week', criado_em AT TIME ZONE 'America/Sao_Paulo')
  ) * 100, 1) AS share_pct
FROM siso_pedidos
WHERE status NOT IN ('cancelado')
GROUP BY 1, 2
ORDER BY 1, 3 DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — planejamento estrategico de canais

**Quick Win:** Sim

---

### CATEGORIA 8: OPERACOES DE ARMAZEM

---

**INSIGHT 8.1 — Otimizacao de Rota de Picking por Localizacao**

**Pergunta de Negocio:** Em que ordem os operadores devem separar os itens para minimizar deslocamento no galpao?

**Fontes de Dados:**
- `siso_pedido_item_estoques`: `produto_id`, `empresa_id`, `localizacao`
- `siso_pedido_itens`: `pedido_id`, `produto_id`, `sku`
- `siso_pedidos`: `separacao_galpao_id`, `status_separacao`

**Abordagem SQL/Analitica:**
```sql
-- Extrai componentes de localizacao (ex: A-01-03 -> corredor A, prateleira 01, posicao 03)
SELECT
  pie.localizacao,
  SPLIT_PART(pie.localizacao, '-', 1) AS corredor,
  SPLIT_PART(pie.localizacao, '-', 2)::int AS prateleira,
  SPLIT_PART(pie.localizacao, '-', 3)::int AS posicao,
  pi.sku,
  p.id AS pedido_id
FROM siso_pedido_item_estoques pie
JOIN siso_pedido_itens pi ON pi.produto_id = pie.produto_id AND pi.pedido_id = pie.pedido_id
JOIN siso_pedidos p ON p.id = pi.pedido_id
JOIN siso_empresas e ON e.id = pie.empresa_id
WHERE p.status_separacao IN ('aguardando_separacao', 'em_separacao')
  AND pie.localizacao IS NOT NULL AND pie.localizacao != ''
ORDER BY SPLIT_PART(pie.localizacao, '-', 1),
         SPLIT_PART(pie.localizacao, '-', 2)::int,
         SPLIT_PART(pie.localizacao, '-', 3)::int;
```

Modelo: TSP aproximado (vizinho mais proximo) sobre as coordenadas de localizacao para cada ola de separacao. Reducao tipica de deslocamento: 20-40% em galpoes medianos.

**Complexidade:** Complexa (algoritmo de otimizacao de rota)

**Impacto de Negocio:** Alto — reduz tempo de picking diretamente

**Quick Win:** Nao (requer desenvolvimento de algoritmo)

---

**INSIGHT 8.2 — Mapa de Calor do Galpao: Zonas com Maior Fluxo de Picking**

**Pergunta de Negocio:** Quais localizacoes sao visitadas mais vezes por dia? Os produtos mais demandados estao proximos da area de embalagem?

**Fontes de Dados:**
- `siso_pedido_item_estoques`: `localizacao`, `produto_id`
- `siso_pedido_itens`: `produto_id`, `bipado_em`, `quantidade_pedida`

**Abordagem SQL/Analitica:**
```sql
-- Frequencia de picking por localizacao
SELECT
  pie.localizacao,
  SPLIT_PART(pie.localizacao, '-', 1) AS corredor,
  COUNT(*) AS visitas_picking,
  SUM(pi.quantidade_pedida) AS unidades_coletadas,
  COUNT(DISTINCT pi.pedido_id) AS pedidos_atendidos,
  MAX(pi.bipado_em) AS ultimo_acesso
FROM siso_pedido_item_estoques pie
JOIN siso_pedido_itens pi ON pi.produto_id = pie.produto_id AND pi.pedido_id = pie.pedido_id
WHERE pie.localizacao IS NOT NULL AND pi.bipado_em IS NOT NULL
GROUP BY pie.localizacao, 2
ORDER BY visitas_picking DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — reorganizar galpao colocando produtos A perto da saida

**Quick Win:** Sim

---

**INSIGHT 8.3 — Afinidade de Produtos no Picking (Market Basket Analysis)**

**Pergunta de Negocio:** Quais SKUs aparecem frequentemente juntos num mesmo pedido? Posso agrupar esses produtos fisicamente no galpao?

**Fontes de Dados:**
- `siso_pedido_itens`: `pedido_id`, `sku`

**Abordagem SQL/Analitica:**
```sql
-- Pares de SKUs que aparecem juntos em pedidos (suporte >= 5 co-ocorrencias)
SELECT
  a.sku AS sku_a,
  b.sku AS sku_b,
  COUNT(DISTINCT a.pedido_id) AS co_ocorrencias,
  ROUND(
    COUNT(DISTINCT a.pedido_id)::numeric /
    (SELECT COUNT(DISTINCT pedido_id) FROM siso_pedido_itens WHERE sku = a.sku) * 100, 1
  ) AS confianca_pct
FROM siso_pedido_itens a
JOIN siso_pedido_itens b ON b.pedido_id = a.pedido_id AND b.sku > a.sku
GROUP BY a.sku, b.sku
HAVING COUNT(DISTINCT a.pedido_id) >= 5
ORDER BY co_ocorrencias DESC
LIMIT 50;
```

Modelo: Algoritmo Apriori ou FP-Growth para regras de associacao. Com 10.000+ pedidos ja ha suporte estatistico suficiente para pares de alto volume.

**Complexidade:** Media

**Impacto de Negocio:** Medio — reorganizacao de galpao por afinidade reduz distancia percorrida

**Quick Win:** Sim (versao SQL)

---

**INSIGHT 8.4 — Taxa de Utilizacao de Localizacao por Corredor**

**Pergunta de Negocio:** Ha corredores subutilizados? Estou usando o espaco de forma eficiente?

**Fontes de Dados:**
- `siso_inventario_itens`: `localizacao`, `sku`, `quantidade`, `inventario_id`
- `siso_pedido_item_estoques`: `localizacao`, `produto_id`, `disponivel`

**Abordagem SQL/Analitica:**
```sql
-- Densidade de produtos por corredor (ultimo inventario)
WITH ultimo_inventario AS (
  SELECT ii.*
  FROM siso_inventario_itens ii
  JOIN siso_inventarios i ON i.id = ii.inventario_id
  WHERE i.status = 'concluido'
    AND i.concluido_em = (SELECT MAX(concluido_em) FROM siso_inventarios WHERE status = 'concluido')
)
SELECT
  SPLIT_PART(localizacao, '-', 1) AS corredor,
  COUNT(DISTINCT sku) AS skus_distintos,
  COUNT(*) AS registros,
  SUM(quantidade) AS total_unidades,
  ROUND(AVG(quantidade), 1) AS unidades_media_por_posicao
FROM ultimo_inventario
WHERE localizacao IS NOT NULL
GROUP BY 1
ORDER BY total_unidades DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Baixo-Medio — otimizacao de espaco fisico

**Quick Win:** Sim

---

### CATEGORIA 9: QUALIDADE E RISCO

---

**INSIGHT 9.1 — Mapa de Falhas de Sistema: Categorias de Erro mais Frequentes**

**Pergunta de Negocio:** Quais tipos de erro estao ocorrendo mais? Ha padroes temporais (erros de madrugada vs dia)?

**Fontes de Dados:**
- `siso_erros`: `source`, `category`, `severity`, `message`, `timestamp`, `request_path`
- `siso_logs`: `level`, `source`, `message`, `criado_em`

**Abordagem SQL/Analitica:**
```sql
-- Distribuicao de erros por categoria, fonte e hora do dia
SELECT
  category,
  source,
  severity,
  EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Sao_Paulo') AS hora,
  COUNT(*) AS total_erros,
  COUNT(DISTINCT correlation_id) AS incidentes_distintos,
  -- Pico de erros
  MAX(timestamp) AS ultimo_erro
FROM siso_erros
WHERE timestamp >= NOW() - INTERVAL '7 days'
GROUP BY 1, 2, 3, 4
ORDER BY total_erros DESC
LIMIT 30;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — reduzir erros do sistema melhora throughput e confiabilidade

**Quick Win:** Sim

---

**INSIGHT 9.2 — Taxa de Falha de Webhook por CNPJ/Empresa**

**Pergunta de Negocio:** Alguma empresa esta tendo mais webhooks falhando do que outras? Ha padroes de reprocessamento?

**Fontes de Dados:**
- `siso_webhook_logs`: `cnpj`, `empresa_id`, `tipo`, `status`, `erro`, `criado_em`, `processado_em`

**Abordagem SQL/Analitica:**
```sql
SELECT
  wl.cnpj,
  e.nome AS empresa,
  wl.tipo,
  COUNT(*) AS total_webhooks,
  COUNT(*) FILTER (WHERE wl.status = 'processado') AS processados,
  COUNT(*) FILTER (WHERE wl.status = 'erro') AS com_erro,
  COUNT(*) FILTER (WHERE wl.status IN ('pendente', 'reprocessando')) AS pendentes,
  ROUND(
    COUNT(*) FILTER (WHERE wl.status = 'erro')::numeric / COUNT(*) * 100, 2
  ) AS taxa_erro_pct,
  ROUND(AVG(EXTRACT(EPOCH FROM (wl.processado_em - wl.criado_em)))
    FILTER (WHERE wl.processado_em IS NOT NULL), 1) AS tempo_medio_processamento_seg
FROM siso_webhook_logs wl
LEFT JOIN siso_empresas e ON e.id = wl.empresa_id
GROUP BY wl.cnpj, e.nome, wl.tipo
ORDER BY taxa_erro_pct DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Alto — webhooks falhando = pedidos perdidos = vendas perdidas

**Quick Win:** Sim

---

**INSIGHT 9.3 — Pedidos em Risco de Cancelamento por SLA**

**Pergunta de Negocio:** Quais pedidos no backlog atual tem risco alto de cancelamento (prazo passando E ainda em OC)?

**Fontes de Dados:**
- `siso_pedidos`: `status_separacao`, `prazo_envio`, `decisao_final`, `nome_ecommerce`, `criado_em`
- `siso_pedido_itens`: `compra_status`, `fornecedor_oc`, `compra_solicitada_em`

Esta query ja foi apresentada no INSIGHT 4.4. Aqui o foco e o alerta operacional em tempo real.

**Abordagem:** Dashboard em tempo real com atualizacao a cada 5 minutos, listando pedidos com prazo em menos de 4 horas e ainda no pipeline OC. Trigger de notificacao para o comprador responsavel.

**Complexidade:** Media

**Impacto de Negocio:** Muito Alto — previne penalizacoes antes que ocorram

**Quick Win:** Sim

---

**INSIGHT 9.4 — Deteccao de Anomalia em Volume de Pedidos**

**Pergunta de Negocio:** Volume de hoje esta estatisticamente anormal? E um pico real de demanda ou pode ser erro de integracao?

**Fontes de Dados:**
- `siso_pedidos`: `criado_em`, `empresa_origem_id`
- `siso_webhook_logs`: `criado_em`, `status`, `cnpj`

**Abordagem SQL/Analitica:**
```sql
-- Z-score do volume horario atual vs historico das ultimas 3 semanas
WITH volume_historico AS (
  SELECT
    DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') AS dia,
    EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Sao_Paulo') AS hora,
    COUNT(*) AS volume
  FROM siso_pedidos
  WHERE criado_em >= NOW() - INTERVAL '21 days'
    AND status NOT IN ('cancelado')
  GROUP BY 1, 2
),
stats_por_hora AS (
  SELECT hora,
    AVG(volume) AS media,
    STDDEV(volume) AS desvio
  FROM volume_historico
  GROUP BY hora
)
SELECT
  vh.dia, vh.hora, vh.volume,
  ROUND(s.media, 1) AS media_historica,
  ROUND(s.desvio, 1) AS desvio_historico,
  ROUND((vh.volume - s.media) / NULLIF(s.desvio, 0), 2) AS z_score,
  CASE
    WHEN ABS((vh.volume - s.media) / NULLIF(s.desvio, 0)) > 3 THEN 'ANOMALIA_CRITICA'
    WHEN ABS((vh.volume - s.media) / NULLIF(s.desvio, 0)) > 2 THEN 'ANOMALIA'
    ELSE 'NORMAL'
  END AS classificacao
FROM volume_historico vh
JOIN stats_por_hora s ON s.hora = vh.hora
WHERE vh.dia >= CURRENT_DATE - INTERVAL '3 days'
ORDER BY vh.dia DESC, vh.hora DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Medio — previne processamento de dados errados por bug de integracao

**Quick Win:** Sim

---

**INSIGHT 9.5 — Taxa de Retrabalho no Pipeline**

**Pergunta de Negocio:** Com que frequencia pedidos voltam de um status para outro (reversoes, reprocessamentos)? Isso indica qualidade operacional baixa?

**Fontes de Dados:**
- `siso_pedido_historico`: `evento`, `pedido_id`, `criado_em`, `usuario_nome`
- Eventos: `status_revertido`, `separacao_reiniciada`, `etiqueta_falhou`, `forcar_pendente`

**Abordagem SQL/Analitica:**
```sql
SELECT
  DATE(h.criado_em AT TIME ZONE 'America/Sao_Paulo') AS dia,
  h.evento,
  COUNT(DISTINCT h.pedido_id) AS pedidos_afetados,
  COUNT(*) AS ocorrencias,
  ARRAY_AGG(DISTINCT h.usuario_nome) FILTER (WHERE h.usuario_nome IS NOT NULL) AS operadores
FROM siso_pedido_historico h
WHERE h.evento IN (
  'status_revertido', 'separacao_reiniciada', 'etiqueta_falhou',
  'cancelado', 'erro', 'forcar_pendente', 'desfazer_bip'
)
GROUP BY 1, 2
ORDER BY 1 DESC, 4 DESC;
```

**Complexidade:** Simples

**Impacto de Negocio:** Medio — identificar causas raiz de retrabalho

**Quick Win:** Sim

---

### CATEGORIA 10: INTELIGENCIA ESTRATEGICA

---

**INSIGHT 10.1 — Modelo de Classificacao de Risco de Atraso (ML)**

**Pergunta de Negocio:** Conseguimos prever, no momento que o pedido chega, se ele vai atrasar? Com que antecedencia?

**Fontes de Dados:**
- `siso_pedidos`: todos os campos disponiveis no momento do recebimento
- `siso_pedido_itens`: contagem de itens, SKUs, fornecedores
- `siso_pedido_item_estoques`: disponibilidade de estoque

**Abordagem ML:**

Features de entrada (disponiveis no momento do webhook):
- Canal de origem (one-hot encoding)
- Hora do dia / dia da semana
- Numero de itens no pedido
- Numero de SKUs distintos
- `decisao_final` prevista (propria/transferencia/oc)
- Disponibilidade de estoque total (`sum(disponivel)`)
- Slack de prazo em horas (`prazo_envio - criado_em`)
- Volume atual no pipeline no momento do pedido
- Numero de operadores ativos

Target: `1` se `embalagem_concluida_em > prazo_envio` ou pedido cancelado, `0` caso contrario.

Modelo: Gradient Boosted Tree (XGBoost/LightGBM) com validacao temporal (treino em semanas 1-2, teste em semana 3). Com 10.000+ registros ja e possivel treinar um modelo baseline funcional.

```python
import pandas as pd
from xgboost import XGBClassifier
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score, precision_recall_curve

# Feature engineering
df['slack_horas'] = (df['prazo_envio'] - df['criado_em']).dt.total_seconds() / 3600
df['hora_chegada'] = df['criado_em'].dt.hour
df['dia_semana'] = df['criado_em'].dt.dayofweek
df['e_oc'] = (df['decisao_final'] == 'oc').astype(int)
df['e_transferencia'] = (df['decisao_final'] == 'transferencia').astype(int)
df['canal_ml'] = df['nome_ecommerce'].str.lower().str.contains('mercado livre').astype(int)

# Target
df['atrasou'] = (
    (df['embalagem_concluida_em'] > df['prazo_envio']) |
    (df['status'] == 'cancelado')
).astype(int)

# TimeSeriesSplit validation
tscv = TimeSeriesSplit(n_splits=3)
model = XGBClassifier(n_estimators=200, max_depth=5, learning_rate=0.05)
```

**Complexidade:** Complexa

**Impacto de Negocio:** Muito Alto — alerta preditivo 6-12h antes do atraso, permitindo intervencao

**Quick Win:** Nao (requer implementacao de pipeline ML)

---

**INSIGHT 10.2 — Otimizacao dos Criterios de Auto-Aprovacao**

**Pergunta de Negocio:** Posso expandir os criterios de auto-aprovacao com seguranca? Quais pedidos `transferencia` ou `oc` teriam resultado identico ao de pedidos `propria` auto-aprovados?

**Fontes de Dados:**
- `siso_pedidos`: `sugestao`, `decisao_final`, `tipo_resolucao`, `status`, `embalagem_concluida_em`, `prazo_envio`
- `siso_pedido_item_estoques`: `disponivel`

**Abordagem SQL/Analitica:**
```sql
-- Caracteristicas de pedidos 'propria' vs outros que foram bem-sucedidos
SELECT
  decisao_final,
  tipo_resolucao,
  COUNT(*) AS total,
  -- Performance
  ROUND(AVG(EXTRACT(EPOCH FROM (embalagem_concluida_em - criado_em)) / 60)
    FILTER (WHERE embalagem_concluida_em IS NOT NULL), 0) AS lead_time_medio_min,
  ROUND(
    COUNT(*) FILTER (WHERE embalagem_concluida_em <= prazo_envio)::numeric /
    NULLIF(COUNT(*) FILTER (WHERE embalagem_concluida_em IS NOT NULL AND prazo_envio IS NOT NULL), 0) * 100, 1
  ) AS pct_no_prazo,
  -- Distribuicao de estoque disponivel no momento (media)
  ROUND(AVG(pie.disponivel_total), 1) AS disponivel_medio_no_momento
FROM siso_pedidos p
LEFT JOIN (
  SELECT pedido_id, SUM(disponivel) AS disponivel_total
  FROM siso_pedido_item_estoques
  GROUP BY pedido_id
) pie ON pie.pedido_id = p.id
WHERE p.status NOT IN ('cancelado')
GROUP BY 1, 2
ORDER BY 1, 2;
```

Modelo: Arvore de decisao para identificar thresholds de estoque disponivel e canal que predizem sucesso de pedidos `transferencia`. Se `transferencia` com `disponivel >= X` tem lead time e SLA comparavel a `propria`, esse subconjunto e candidato a auto-aprovacao.

**Complexidade:** Media

**Impacto de Negocio:** Alto — reduz carga de trabalho de aprovacao manual sem sacrificar qualidade

**Quick Win:** Sim (analise inicial)

---

**INSIGHT 10.3 — Dashboard de Saude do Sistema (System Health Score)**

**Pergunta de Negocio:** Tenho uma visao consolidada da saude do sistema em tempo real? Posso detectar degradacao antes que vire incidente?

**Fontes de Dados:**
- `siso_erros`: `timestamp`, `severity`, `category`
- `siso_fila_execucao`: `status`, `tentativas`, `criado_em`
- `siso_webhook_logs`: `status`, `criado_em`
- `siso_pedidos`: `status`, `status_separacao`, `criado_em`

**Abordagem SQL/Analitica:**
```sql
-- Score de saude composto (0-100) baseado em metricas operacionais
WITH metricas AS (
  SELECT
    -- 1. Taxa de erro de webhook (peso: 30%)
    (SELECT ROUND((1 - COUNT(*) FILTER (WHERE status = 'erro')::numeric / NULLIF(COUNT(*), 0)) * 100, 1)
     FROM siso_webhook_logs WHERE criado_em >= NOW() - INTERVAL '1 hour') AS score_webhook,
    -- 2. Taxa de erro na fila de execucao (peso: 25%)
    (SELECT ROUND((1 - COUNT(*) FILTER (WHERE status = 'erro')::numeric / NULLIF(COUNT(*), 0)) * 100, 1)
     FROM siso_fila_execucao WHERE criado_em >= NOW() - INTERVAL '1 hour') AS score_fila,
    -- 3. Pedidos envelhecidos (peso: 25%)
    (SELECT ROUND((1 - COUNT(*) FILTER (WHERE status_separacao = 'aguardando_nf' AND criado_em < NOW() - INTERVAL '4 hours')::numeric / NULLIF(COUNT(*) FILTER (WHERE status_separacao = 'aguardando_nf'), 0)) * 100, 1)
     FROM siso_pedidos) AS score_aging,
    -- 4. Erros criticos recentes (peso: 20%)
    (SELECT CASE WHEN COUNT(*) = 0 THEN 100 WHEN COUNT(*) < 5 THEN 70 ELSE 30 END
     FROM siso_erros WHERE severity = 'critical' AND timestamp >= NOW() - INTERVAL '1 hour') AS score_erros_criticos
)
SELECT
  score_webhook,
  score_fila,
  score_aging,
  score_erros_criticos,
  ROUND((COALESCE(score_webhook,100) * 0.30 +
         COALESCE(score_fila,100) * 0.25 +
         COALESCE(score_aging,100) * 0.25 +
         score_erros_criticos * 0.20), 1) AS health_score_total
FROM metricas;
```

**Complexidade:** Media

**Impacto de Negocio:** Medio — visibilidade executiva da saude do sistema

**Quick Win:** Sim

---

**INSIGHT 10.4 — Simulacao de Impacto de Expansao para Novo Galpao**

**Pergunta de Negocio:** Se eu abrir um terceiro galpao em uma nova cidade, qual percentual da demanda atual seria atendida localmente?

**Fontes de Dados:**
- `siso_pedidos`: `decisao_final`, `empresa_origem_id`, `criado_em`, `cliente_cpf_cnpj`
- `siso_pedido_itens`: `sku`, `fornecedor_oc`
- `siso_transferencia_itens`: `sku`, `quantidade`

**Abordagem SQL/Analitica:**
```sql
-- Analise de transferencias e OCs por fornecedor como proxy de necessidade de terceiro galpao
SELECT
  pi.fornecedor_oc AS fornecedor,
  COUNT(*) FILTER (WHERE p.decisao_final = 'transferencia') AS pedidos_transferencia,
  COUNT(*) FILTER (WHERE p.decisao_final = 'oc') AS pedidos_oc,
  COUNT(*) AS total_pedidos,
  ROUND(
    (COUNT(*) FILTER (WHERE p.decisao_final IN ('transferencia', 'oc')))::numeric /
    NULLIF(COUNT(*), 0) * 100, 1
  ) AS pct_dependencia_externa,
  SUM(pi.quantidade_pedida) AS unidades_totais
FROM siso_pedido_itens pi
JOIN siso_pedidos p ON p.id = pi.pedido_id
WHERE p.status NOT IN ('cancelado') AND pi.fornecedor_oc IS NOT NULL
GROUP BY pi.fornecedor_oc
ORDER BY pct_dependencia_externa DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Alto para planejamento estrategico de longo prazo

**Quick Win:** Sim (analise inicial)

---

**INSIGHT 10.5 — Modelo de Score de Prioridade Dinamico para Separacao**

**Pergunta de Negocio:** Como ordenar a fila de separacao para maximizar o numero de pedidos entregues no prazo?

**Fontes de Dados:**
- `siso_pedidos`: `prazo_envio`, `criado_em`, `nome_ecommerce`, `decisao_final`, `status_separacao`
- `siso_pedido_itens`: contagem de itens, `compra_status`

**Abordagem:**

Score de prioridade composto calculado em tempo real:

```sql
SELECT
  p.id,
  p.numero,
  p.prazo_envio,
  p.nome_ecommerce,
  p.decisao_final,
  -- Componente 1: urgencia temporal (0-50 pontos)
  CASE
    WHEN p.prazo_envio < NOW() THEN 50
    WHEN p.prazo_envio < NOW() + INTERVAL '2 hours' THEN 45
    WHEN p.prazo_envio < NOW() + INTERVAL '4 hours' THEN 35
    WHEN p.prazo_envio < NOW() + INTERVAL '8 hours' THEN 20
    ELSE 10
  END AS score_urgencia,
  -- Componente 2: canal de alto risco (0-25 pontos)
  CASE
    WHEN LOWER(p.nome_ecommerce) LIKE '%mercado livre%' THEN 25
    WHEN LOWER(p.nome_ecommerce) LIKE '%amazon%' THEN 20
    WHEN LOWER(p.nome_ecommerce) LIKE '%shopee%' THEN 15
    ELSE 10
  END AS score_canal,
  -- Componente 3: simplicidade do pedido (favorece pedidos rapidos primeiro) (0-15 pontos)
  CASE
    WHEN n_itens.total <= 2 THEN 15
    WHEN n_itens.total <= 5 THEN 10
    ELSE 5
  END AS score_simplicidade,
  -- Componente 4: pedidos propria tem prioridade sobre OC/transferencia (0-10 pontos)
  CASE p.decisao_final
    WHEN 'propria' THEN 10
    WHEN 'transferencia' THEN 6
    WHEN 'oc' THEN 2
    ELSE 5
  END AS score_decisao,
  -- Score total
  (CASE WHEN p.prazo_envio < NOW() THEN 50
        WHEN p.prazo_envio < NOW() + INTERVAL '2 hours' THEN 45
        WHEN p.prazo_envio < NOW() + INTERVAL '4 hours' THEN 35
        ELSE 10 END +
   CASE WHEN LOWER(p.nome_ecommerce) LIKE '%mercado livre%' THEN 25 ELSE 10 END +
   CASE WHEN n_itens.total <= 2 THEN 15 WHEN n_itens.total <= 5 THEN 10 ELSE 5 END +
   CASE p.decisao_final WHEN 'propria' THEN 10 WHEN 'transferencia' THEN 6 ELSE 2 END
  ) AS score_total
FROM siso_pedidos p
JOIN (
  SELECT pedido_id, COUNT(*) AS total FROM siso_pedido_itens GROUP BY pedido_id
) n_itens ON n_itens.pedido_id = p.id
WHERE p.status_separacao = 'aguardando_separacao'
ORDER BY score_total DESC;
```

**Complexidade:** Media

**Impacto de Negocio:** Muito Alto — mesmo ganho de 5% no SLA de prazo significa dezenas de penalizacoes a menos por mes

**Quick Win:** Sim — pode ser implementado como coluna calculada ou view materializada

---

## RESUMO EXECUTIVO: MAPA DE PRIORIDADE

| Categoria | Insight | Impacto | Complexidade | Quick Win |
|---|---|---|---|---|
| Estoque | 2.1 Taxa de Ruptura por SKU | Alto | Simples | Sim |
| Compras | 4.4 Score de Risco de OC vs Prazo | Muito Alto | Media | Sim |
| Estrategico | 10.5 Score de Prioridade de Separacao | Muito Alto | Media | Sim |
| Fulfillment | 3.3 Taxa de Atendimento no Prazo | Alto | Simples | Sim |
| Compras | 4.1 Lead Time Real por Fornecedor | Alto | Simples | Sim |
| Estoque | 2.3 Ponto de Reposicao Dinamico | Alto | Media | Sim |
| Fulfillment | 3.4 Acuracia da Sugestao do Sistema | Alto | Simples | Sim |
| Operadores | 5.1 Produtividade por Operador | Alto | Simples | Sim |
| Qualidade | 9.1 Mapa de Falhas de Sistema | Alto | Simples | Sim |
| ML | 10.1 Modelo Preditivo de Atraso | Muito Alto | Complexa | Nao |
| Armazem | 8.1 Otimizacao de Rota de Picking | Alto | Complexa | Nao |

---

## LACUNAS DE DADOS: O QUE COLETAR PARA EXPANDIR INSIGHTS

As seguintes informacoes nao existem no banco atual mas teriam altissimo valor analitico se coletadas:

1. **Valor monetario dos pedidos** — sem valor unitario por SKU, nao e possivel calcular ticket medio, margem por canal ou custo real de stockout. Recomendacao: incluir o `valor_total` do pedido via webhook do Tiny (campo disponivel no payload) e `preco_unitario` por item.

2. **Peso e dimensoes dos itens** — ausentes. Importantes para otimizacao de rota de picking e estimativa de custo de frete de transferencia.

3. **Feedback de cancelamento do marketplace** — o campo `status = 'cancelado'` existe mas nao ha motivo do cancelamento (cliente cancelou, prazo estourado, marketplace cancelou automaticamente). Diferenciar entre esses casos seria fundamental para o modelo de risco.

4. **Localizacao fisica padronizada** — o campo `localizacao` existe mas nao ha garantia de formato padronizado (ex: "A-01-03" vs "Prateleira A1" vs "Caixa 5"). Uma migracao de normalizacao de localizacoes desbloquearia os insights 8.1 e 8.2 completamente.

5. **Timestamps de expedicao real** — o campo `status_separacao = 'expedido'` existe mas nao ha `expedido_em` com timestamp preciso. A diferenca entre `embalagem_concluida_em` e o momento da coleta pela transportadora e critica para medir o SLA completo.

6. **Score de avaliacao do vendedor por canal** — dados de reputacao do Mercado Livre e Shopee permitiriam correlacionar comportamento operacional com pontuacao do vendedor, criando um incentivo financeiro mensuravel para cada insight de SLA.

---

Os arquivos de codigo mais relevantes para implementar estes insights estao em:

- `/Users/eryk/Documents/ESTOQUE/src/app/api/painel/route.ts` — base para expandir o endpoint com novas metricas
- `/Users/eryk/Documents/ESTOQUE/src/lib/sku-fornecedor.ts` — mapeamento de fornecedor usado em queries de compras
- `/Users/eryk/Documents/ESTOQUE/src/lib/compras-release.ts` — logica de liberacao de OC com timestamps criticos
- `/Users/eryk/Documents/ESTOQUE/supabase/migrations/` — todas as definicoes de schema para construir queries precisas
