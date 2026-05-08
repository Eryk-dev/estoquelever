-- WMS Foundation — schema 4D + ledger imutável
-- Spec: docs/superpowers/specs/2026-05-07-wms-design.md §3.1-3.6, 3.9
-- Plan: docs/superpowers/plans/2026-05-08-wms-1-foundation.md

BEGIN;

-- 1. Cargo supervisor_logistica em siso_usuarios
ALTER TABLE siso_usuarios
  DROP CONSTRAINT IF EXISTS siso_usuarios_cargo_check;
ALTER TABLE siso_usuarios
  ADD CONSTRAINT siso_usuarios_cargo_check
  CHECK (cargo IN ('admin','operador_cwb','operador_sp','comprador','supervisor_logistica'));

-- 2. Catálogo unificado
CREATE TABLE IF NOT EXISTS siso_produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  descricao text NOT NULL,
  gtin text,
  imagem_url text,
  unidade text NOT NULL DEFAULT 'UN',
  ncm text,
  cest text,
  origem_fiscal smallint CHECK (origem_fiscal IS NULL OR origem_fiscal BETWEEN 0 AND 8),
  sincronizado_em timestamptz,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_produtos_sku ON siso_produtos(sku);
CREATE INDEX IF NOT EXISTS idx_produtos_gtin ON siso_produtos(gtin) WHERE gtin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_produtos_ativo ON siso_produtos(ativo) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_produtos_sincronizado ON siso_produtos(sincronizado_em);

-- 3. Mapeamento SKU ↔ Tiny por empresa
CREATE TABLE IF NOT EXISTS siso_produto_empresas (
  produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  empresa_id uuid NOT NULL REFERENCES siso_empresas(id) ON DELETE CASCADE,
  tiny_produto_id bigint NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  PRIMARY KEY (produto_id, empresa_id),
  UNIQUE(empresa_id, tiny_produto_id)
);

CREATE INDEX IF NOT EXISTS idx_prod_emp_tiny ON siso_produto_empresas(empresa_id, tiny_produto_id);

-- 4. Galpões: geolocalização
ALTER TABLE siso_galpoes
  ADD COLUMN IF NOT EXISTS cidade text,
  ADD COLUMN IF NOT EXISTS estado text,
  ADD COLUMN IF NOT EXISTS pais text NOT NULL DEFAULT 'BR';
ALTER TABLE siso_galpoes
  DROP CONSTRAINT IF EXISTS siso_galpoes_estado_check;
ALTER TABLE siso_galpoes
  ADD CONSTRAINT siso_galpoes_estado_check
  CHECK (estado IS NULL OR estado ~ '^[A-Z]{2}$');

-- 5. Localizações dentro de galpão
CREATE TABLE IF NOT EXISTS siso_localizacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  codigo text NOT NULL,
  descricao text,
  tipo text NOT NULL DEFAULT 'picking' CHECK (tipo IN (
    'picking','overstock','recebimento','expedicao','quarentena'
  )),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(galpao_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_loc_galpao ON siso_localizacoes(galpao_id) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_loc_tipo ON siso_localizacoes(galpao_id, tipo) WHERE ativo;

-- 6. Estoque: cache materializado da posição atual (quádrupla)
CREATE TABLE IF NOT EXISTS siso_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  saldo numeric NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  reservado numeric NOT NULL DEFAULT 0 CHECK (reservado >= 0),
  disponivel numeric GENERATED ALWAYS AS (saldo - reservado) STORED,
  custo_medio numeric(12,4) NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE(produto_id, empresa_dona_id, galpao_id, localizacao_id),
  CHECK (reservado <= saldo)
);

CREATE INDEX IF NOT EXISTS idx_estoque_dono ON siso_estoque(empresa_dona_id, produto_id);
CREATE INDEX IF NOT EXISTS idx_estoque_galpao ON siso_estoque(galpao_id, produto_id);
CREATE INDEX IF NOT EXISTS idx_estoque_loc ON siso_estoque(localizacao_id, produto_id);
CREATE INDEX IF NOT EXISTS idx_estoque_disponivel ON siso_estoque(produto_id) WHERE disponivel > 0;

-- 7. Ledger imutável (CORE)
CREATE TABLE IF NOT EXISTS siso_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id uuid NOT NULL REFERENCES siso_galpoes(id),
  localizacao_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  tipo char(1) NOT NULL CHECK (tipo IN ('E','S','R','L')),
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  saldo_anterior numeric NOT NULL CHECK (saldo_anterior >= 0),
  saldo_posterior numeric NOT NULL CHECK (saldo_posterior >= 0),
  reservado_anterior numeric NOT NULL CHECK (reservado_anterior >= 0),
  reservado_posterior numeric NOT NULL CHECK (reservado_posterior >= 0),
  origem_tipo text NOT NULL CHECK (origem_tipo IN (
    'compra_manual','lancamento_retroativo','nf_venda','nf_devolucao_cliente',
    'nf_devolucao_avariada','nf_devolucao_fornecedor','transferencia_galpao',
    'transferencia_localizacao','emprestimo','reserva_pedido','liberacao_reserva',
    'troca_sku_in','troca_sku_out','ajuste_manual','inventario','inventario_inicial',
    'estorno','cancelamento_nf'
  )),
  origem_id text,
  origem_detalhes jsonb NOT NULL DEFAULT '{}',
  emprestimo_devedora_id uuid REFERENCES siso_empresas(id),
  expira_em timestamptz,
  nota_fiscal_id bigint,
  chave_acesso_nf text,
  custo_unitario numeric(12,4),
  usuario_id uuid REFERENCES siso_usuarios(id),
  observacoes text,
  estorno_de uuid REFERENCES siso_movimentacoes(id),
  criado_em timestamptz NOT NULL DEFAULT now(),

  CHECK (
    (origem_tipo = 'emprestimo' AND emprestimo_devedora_id IS NOT NULL)
    OR (origem_tipo <> 'emprestimo' AND emprestimo_devedora_id IS NULL)
  ),
  CHECK (
    (tipo = 'R' AND expira_em IS NOT NULL)
    OR (tipo <> 'R' AND expira_em IS NULL)
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
  ),
  CHECK (reservado_posterior <= saldo_posterior)
);

CREATE INDEX IF NOT EXISTS idx_mov_produto ON siso_movimentacoes(produto_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_mov_dona ON siso_movimentacoes(empresa_dona_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_mov_galpao ON siso_movimentacoes(galpao_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_mov_loc ON siso_movimentacoes(localizacao_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_mov_origem ON siso_movimentacoes(origem_tipo, origem_id);
CREATE INDEX IF NOT EXISTS idx_mov_nf ON siso_movimentacoes(nota_fiscal_id) WHERE nota_fiscal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mov_estorno ON siso_movimentacoes(estorno_de) WHERE estorno_de IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mov_emprestimo
  ON siso_movimentacoes(empresa_dona_id, emprestimo_devedora_id, criado_em DESC)
  WHERE origem_tipo = 'emprestimo';
CREATE INDEX IF NOT EXISTS idx_mov_reserva_expira
  ON siso_movimentacoes(expira_em) WHERE tipo = 'R' AND expira_em IS NOT NULL;

-- 8. Default location pra cada galpão existente (operacional)
INSERT INTO siso_localizacoes (galpao_id, codigo, descricao, tipo)
SELECT id, 'DEFAULT-PICKING', 'Localização padrão (criada automaticamente)', 'picking'
FROM siso_galpoes
WHERE NOT EXISTS (
  SELECT 1 FROM siso_localizacoes l WHERE l.galpao_id = siso_galpoes.id AND l.codigo = 'DEFAULT-PICKING'
);

-- 9. Localização QUARENTENA pra cada galpão (decisão do user: criar em todos)
INSERT INTO siso_localizacoes (galpao_id, codigo, descricao, tipo)
SELECT id, 'QUARENTENA', 'Mercadoria avariada/garantia aguardando descarte ou RMA', 'quarentena'
FROM siso_galpoes
WHERE NOT EXISTS (
  SELECT 1 FROM siso_localizacoes l WHERE l.galpao_id = siso_galpoes.id AND l.codigo = 'QUARENTENA'
);

-- 10. RPC: insere mov no ledger atomicamente com lock pessimista.
-- Toda escrita no ledger passa por aqui (garante chain verificável + sem race).
CREATE OR REPLACE FUNCTION wms_inserir_movimentacao(
  p_produto uuid, p_dona uuid, p_galpao uuid, p_localizacao uuid,
  p_tipo char(1), p_qty numeric,
  p_origem_tipo text, p_origem_id text, p_origem_detalhes jsonb,
  p_emprestimo_devedora uuid, p_expira_em timestamptz,
  p_nota_fiscal_id bigint, p_custo_unitario numeric,
  p_usuario uuid, p_observacoes text, p_estorno_de uuid
) RETURNS siso_movimentacoes LANGUAGE plpgsql AS $$
DECLARE
  v_saldo numeric := 0;
  v_reservado numeric := 0;
  v_saldo_posterior numeric;
  v_reservado_posterior numeric;
  v_mov siso_movimentacoes;
  v_estoque_id uuid;
BEGIN
  -- Lock pessimista. Se a linha não existe (1ª mov), upsert depois.
  SELECT id, saldo, reservado INTO v_estoque_id, v_saldo, v_reservado
  FROM siso_estoque
  WHERE produto_id = p_produto AND empresa_dona_id = p_dona
    AND galpao_id = p_galpao AND localizacao_id = p_localizacao
  FOR UPDATE;

  IF v_estoque_id IS NULL THEN
    v_saldo := 0;
    v_reservado := 0;
  END IF;

  -- Calcula posteriores baseado no tipo
  IF p_tipo = 'E' THEN
    v_saldo_posterior := v_saldo + p_qty;
    v_reservado_posterior := v_reservado;
  ELSIF p_tipo = 'S' THEN
    v_saldo_posterior := v_saldo - p_qty;
    v_reservado_posterior := v_reservado;
  ELSIF p_tipo = 'R' THEN
    v_saldo_posterior := v_saldo;
    v_reservado_posterior := v_reservado + p_qty;
  ELSIF p_tipo = 'L' THEN
    v_saldo_posterior := v_saldo;
    v_reservado_posterior := v_reservado - p_qty;
  ELSE
    RAISE EXCEPTION 'tipo inválido: %', p_tipo;
  END IF;

  -- Validações db-side; CHECKs da tabela vão re-validar
  IF v_saldo_posterior < 0 THEN
    RAISE EXCEPTION 'saldo insuficiente: anterior=% qty=% tipo=%', v_saldo, p_qty, p_tipo;
  END IF;
  IF v_reservado_posterior < 0 THEN
    RAISE EXCEPTION 'reservado iria negativo: anterior=% qty=%', v_reservado, p_qty;
  END IF;
  IF v_reservado_posterior > v_saldo_posterior THEN
    RAISE EXCEPTION 'reservado (%) excederia saldo (%)', v_reservado_posterior, v_saldo_posterior;
  END IF;

  INSERT INTO siso_movimentacoes (
    produto_id, empresa_dona_id, galpao_id, localizacao_id,
    tipo, quantidade,
    saldo_anterior, saldo_posterior,
    reservado_anterior, reservado_posterior,
    origem_tipo, origem_id, origem_detalhes,
    emprestimo_devedora_id, expira_em,
    nota_fiscal_id, custo_unitario,
    usuario_id, observacoes, estorno_de
  ) VALUES (
    p_produto, p_dona, p_galpao, p_localizacao,
    p_tipo, p_qty,
    v_saldo, v_saldo_posterior,
    v_reservado, v_reservado_posterior,
    p_origem_tipo, p_origem_id, p_origem_detalhes,
    p_emprestimo_devedora, p_expira_em,
    p_nota_fiscal_id, p_custo_unitario,
    p_usuario, p_observacoes, p_estorno_de
  ) RETURNING * INTO v_mov;

  IF v_estoque_id IS NOT NULL THEN
    UPDATE siso_estoque
    SET saldo = v_saldo_posterior, reservado = v_reservado_posterior, atualizado_em = now()
    WHERE id = v_estoque_id;
  ELSE
    INSERT INTO siso_estoque (
      produto_id, empresa_dona_id, galpao_id, localizacao_id,
      saldo, reservado
    ) VALUES (
      p_produto, p_dona, p_galpao, p_localizacao,
      v_saldo_posterior, v_reservado_posterior
    );
  END IF;

  RETURN v_mov;
END;
$$;

COMMIT;
