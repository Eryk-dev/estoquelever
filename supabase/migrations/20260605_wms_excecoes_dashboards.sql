-- WMS Plano 5 — Exceções + dashboards
-- Spec: docs/superpowers/specs/2026-05-07-wms-design.md §5.4, 5.8, 8

BEGIN;

-- 1. Fila de devoluções pendentes
CREATE TABLE IF NOT EXISTS siso_devolucoes_pendentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_fiscal_id bigint,
  chave_acesso_nf text,
  pedido_origem_id text,
  pedido_origem_mov_id uuid REFERENCES siso_movimentacoes(id),
  empresa_id uuid REFERENCES siso_empresas(id),
  status text NOT NULL DEFAULT 'aguardando_classificacao' CHECK (status IN (
    'aguardando_classificacao','classificada','aplicada','cancelada'
  )),
  classificacao text CHECK (classificacao IN ('integro','avariado','garantia','troca_sku')),
  classificada_por uuid REFERENCES siso_usuarios(id),
  classificada_em timestamptz,
  payload_webhook jsonb NOT NULL DEFAULT '{}',
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dev_pend_status ON siso_devolucoes_pendentes(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_pend_nota_fiscal
  ON siso_devolucoes_pendentes(nota_fiscal_id)
  WHERE nota_fiscal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dev_pend_chave_acesso
  ON siso_devolucoes_pendentes(chave_acesso_nf)
  WHERE chave_acesso_nf IS NOT NULL;

-- 2. Materialized view de cobertura
DROP MATERIALIZED VIEW IF EXISTS siso_cobertura_estoque;

CREATE MATERIALIZED VIEW siso_cobertura_estoque AS
WITH giro_30d AS (
  SELECT produto_id, empresa_dona_id, galpao_id,
         SUM(quantidade) / 30.0 AS giro_diario
  FROM siso_movimentacoes
  WHERE tipo = 'S'
    AND origem_tipo IN ('nf_venda','emprestimo')
    AND criado_em >= now() - interval '30 days'
    AND estorno_de IS NULL
  GROUP BY produto_id, empresa_dona_id, galpao_id
),
saldo_agregado AS (
  SELECT produto_id, empresa_dona_id, galpao_id,
         SUM(disponivel) AS disponivel_total
  FROM siso_estoque
  GROUP BY produto_id, empresa_dona_id, galpao_id
),
lead_pref AS (
  SELECT pf.produto_id, pf.lead_time_dias_medio
  FROM siso_produto_fornecedores pf
  WHERE pf.preferencial = true AND pf.ativo = true
)
SELECT
  s.produto_id,
  s.empresa_dona_id,
  s.galpao_id,
  s.disponivel_total,
  COALESCE(g.giro_diario, 0) AS giro_diario,
  CASE WHEN g.giro_diario > 0
       THEN s.disponivel_total / g.giro_diario
       ELSE NULL END AS dias_cobertura,
  lp.lead_time_dias_medio AS lead_time_medio,
  CASE
    WHEN g.giro_diario IS NULL OR g.giro_diario = 0 THEN 'sem_giro'
    WHEN s.disponivel_total / g.giro_diario < 7 THEN 'critico'
    WHEN s.disponivel_total / g.giro_diario < 14 THEN 'atencao'
    WHEN lp.lead_time_dias_medio IS NOT NULL
      AND s.disponivel_total / g.giro_diario < lp.lead_time_dias_medio THEN 'lead_time_risco'
    ELSE 'ok'
  END AS status_cobertura
FROM saldo_agregado s
LEFT JOIN giro_30d g USING (produto_id, empresa_dona_id, galpao_id)
LEFT JOIN lead_pref lp USING (produto_id);

CREATE UNIQUE INDEX uq_cobertura
  ON siso_cobertura_estoque(produto_id, empresa_dona_id, galpao_id);
CREATE INDEX idx_cobertura_status
  ON siso_cobertura_estoque(status_cobertura, dias_cobertura);

-- 3. Função pra refresh (cron-friendly)
CREATE OR REPLACE FUNCTION wms_refresh_cobertura()
RETURNS void LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW siso_cobertura_estoque;
$$;

-- 4. QUARENTENA idempotente em todos os galpões
INSERT INTO siso_localizacoes (galpao_id, codigo, descricao, tipo)
SELECT id, 'QUARENTENA', 'Localização para itens avariados, garantia ou aguardando RMA', 'quarentena'
FROM siso_galpoes g
WHERE NOT EXISTS (
  SELECT 1 FROM siso_localizacoes l
  WHERE l.galpao_id = g.id AND l.codigo = 'QUARENTENA'
);

COMMIT;
