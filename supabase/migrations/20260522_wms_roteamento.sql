-- WMS Plano 3 — Decisões de roteamento
-- Spec: docs/superpowers/specs/2026-05-07-wms-design.md §3.7, 3.8, 6, 7
-- Plano: docs/superpowers/plans/2026-05-22-wms-3-roteamento.md

BEGIN;

-- 1. Fornecedores
CREATE TABLE IF NOT EXISTS siso_fornecedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL UNIQUE,
  cnpj text UNIQUE,
  prefixo_sku text,
  ativo boolean NOT NULL DEFAULT true,
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fornecedor_prefixo ON siso_fornecedores(prefixo_sku) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_fornecedor_cnpj ON siso_fornecedores(cnpj) WHERE cnpj IS NOT NULL;

-- 2. Produto x Fornecedor com lead time
CREATE TABLE IF NOT EXISTS siso_produto_fornecedores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  fornecedor_id uuid NOT NULL REFERENCES siso_fornecedores(id) ON DELETE CASCADE,
  lead_time_dias_min int NOT NULL DEFAULT 7 CHECK (lead_time_dias_min >= 0),
  lead_time_dias_medio int NOT NULL DEFAULT 14 CHECK (lead_time_dias_medio >= 0),
  lead_time_dias_max int NOT NULL DEFAULT 30 CHECK (lead_time_dias_max >= 0),
  ultima_compra_em date,
  custo_unitario numeric(12,4),
  qty_minima_pedido numeric NOT NULL DEFAULT 1,
  multiplo_compra numeric NOT NULL DEFAULT 1,
  preferencial boolean NOT NULL DEFAULT false,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_id, fornecedor_id),
  CHECK (lead_time_dias_min <= lead_time_dias_medio),
  CHECK (lead_time_dias_medio <= lead_time_dias_max)
);

CREATE INDEX IF NOT EXISTS idx_pf_produto ON siso_produto_fornecedores(produto_id) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_pf_fornecedor ON siso_produto_fornecedores(fornecedor_id) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_pf_preferencial ON siso_produto_fornecedores(produto_id) WHERE preferencial AND ativo;

-- 3. Matriz de empréstimos N×N direcional
CREATE TABLE IF NOT EXISTS siso_emprestimo_regras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_credora_id uuid NOT NULL REFERENCES siso_empresas(id),
  empresa_devedora_id uuid NOT NULL REFERENCES siso_empresas(id),
  ativo boolean NOT NULL DEFAULT true,
  limite_max_por_produto numeric,
  limites_por_produto jsonb NOT NULL DEFAULT '{}'::jsonb,
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_credora_id, empresa_devedora_id),
  CHECK (empresa_credora_id <> empresa_devedora_id)
);

CREATE INDEX IF NOT EXISTS idx_regra_devedora ON siso_emprestimo_regras(empresa_devedora_id) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_regra_credora ON siso_emprestimo_regras(empresa_credora_id) WHERE ativo;

-- 4. Lock de localização (usado em planos posteriores; criado aqui pra antecipar)
CREATE TABLE IF NOT EXISTS siso_localizacao_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  motivo text NOT NULL CHECK (motivo IN ('cycle_count','contagem_completa','manutencao')),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  iniciado_por uuid NOT NULL REFERENCES siso_usuarios(id),
  finalizado_em timestamptz,
  observacoes text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_loc_lock_ativo
  ON siso_localizacao_locks(localizacao_id) WHERE finalizado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_loc_lock_ativos
  ON siso_localizacao_locks(iniciado_em) WHERE finalizado_em IS NULL;

-- 5. RPC: reserva atômica delegando ao helper canônico do Plano 1
CREATE OR REPLACE FUNCTION wms_reservar_atomico(
  p_produto uuid, p_dona uuid, p_galpao uuid, p_localizacao uuid,
  p_qty numeric, p_pedido text, p_ttl_horas int DEFAULT 48,
  p_usuario uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_mov siso_movimentacoes;
BEGIN
  v_mov := wms_inserir_movimentacao(
    p_produto, p_dona, p_galpao, p_localizacao,
    'R', p_qty,
    'reserva_pedido', p_pedido, NULL,
    NULL,
    now() + (p_ttl_horas || ' hours')::interval,
    NULL, NULL,
    p_usuario, NULL, NULL
  );
  RETURN v_mov.id;
END;
$$;

-- 6. RPC: saldos devedores líquidos por par credora↔devedora por produto.
-- Saldo = devido_por_credora_a − devido_por_credora_b (movs de empréstimo
-- ainda não estornadas, líquidas em ambas direções).
CREATE OR REPLACE FUNCTION wms_saldos_devedores()
RETURNS TABLE (
  credora uuid, devedora uuid, produto_id uuid, saldo_liquido numeric
) LANGUAGE sql AS $$
  WITH dividas AS (
    SELECT empresa_dona_id AS credora, emprestimo_devedora_id AS devedora, produto_id,
           SUM(CASE
             WHEN estorno_de IS NULL AND NOT EXISTS (
               SELECT 1 FROM siso_movimentacoes e2 WHERE e2.estorno_de = m.id
             ) THEN quantidade ELSE 0
           END) AS devido
    FROM siso_movimentacoes m
    WHERE origem_tipo = 'emprestimo'
    GROUP BY empresa_dona_id, emprestimo_devedora_id, produto_id
  )
  SELECT
    d1.credora, d1.devedora, d1.produto_id,
    d1.devido - COALESCE(d2.devido, 0)
  FROM dividas d1
  LEFT JOIN dividas d2
    ON d1.credora = d2.devedora AND d1.devedora = d2.credora
   AND d1.produto_id = d2.produto_id
  WHERE d1.devido > COALESCE(d2.devido, 0);
$$;

COMMIT;
