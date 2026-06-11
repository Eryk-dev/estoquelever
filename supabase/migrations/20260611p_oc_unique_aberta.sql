-- P3-06 — findOrCreateOC sem unique constraint → corrida cria OCs duplicadas
-- (mesma fornecedor+galpão em status 'aguardando_compra').
--
-- 1) Pré-limpeza determinística: para cada grupo (fornecedor, galpao_id) com >1
--    OC viva em 'aguardando_compra', escolhe a OC mais ANTIGA (created_at, id)
--    como canônica, re-aponta os itens das duplicatas pra ela e marca as
--    duplicatas como 'cancelado'. Só toca duplicatas — grupos com 1 OC ficam
--    intactos.
-- 2) CREATE UNIQUE INDEX parcial em (fornecedor, galpao_id) WHERE
--    status='aguardando_compra'. galpao_id NULL fica fora do escopo do índice
--    (NULLS distinct) — o caminho com galpão nulo cai no fallback por empresa.

BEGIN;

-- 1a. Identifica a OC canônica (mais antiga) de cada grupo duplicado.
WITH grupos AS (
  SELECT
    id,
    fornecedor,
    galpao_id,
    first_value(id) OVER (
      PARTITION BY fornecedor, galpao_id
      ORDER BY created_at ASC, id ASC
    ) AS canonica_id,
    count(*) OVER (PARTITION BY fornecedor, galpao_id) AS n
  FROM siso_ordens_compra
  WHERE status = 'aguardando_compra'
    AND galpao_id IS NOT NULL
),
duplicatas AS (
  SELECT id, canonica_id
  FROM grupos
  WHERE n > 1 AND id <> canonica_id
)
-- 1b. Re-aponta os itens das duplicatas pra OC canônica.
UPDATE siso_pedido_itens pi
SET ordem_compra_id = d.canonica_id
FROM duplicatas d
WHERE pi.ordem_compra_id = d.id;

-- 1c. Cancela as OCs duplicadas (re-deriva o set; itens já migrados).
WITH grupos AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY fornecedor, galpao_id
      ORDER BY created_at ASC, id ASC
    ) AS canonica_id,
    count(*) OVER (PARTITION BY fornecedor, galpao_id) AS n
  FROM siso_ordens_compra
  WHERE status = 'aguardando_compra'
    AND galpao_id IS NOT NULL
)
UPDATE siso_ordens_compra oc
SET status = 'cancelado'
FROM grupos g
WHERE oc.id = g.id
  AND g.n > 1
  AND g.id <> g.canonica_id;

-- 2. Índice único parcial: impede nova duplicata de OC aberta por
--    (fornecedor, galpao_id). O INSERT do findOrCreateOC captura 23505 e
--    re-seleciona a existente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oc_aberta_fornecedor_galpao
  ON siso_ordens_compra (fornecedor, galpao_id)
  WHERE status = 'aguardando_compra' AND galpao_id IS NOT NULL;

COMMIT;
