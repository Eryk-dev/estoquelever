-- WMS: suporte a kits virtuais (sem estoque próprio, derivado dos componentes)
--
-- Regras:
-- 1. Kit é um siso_produto normal com eh_kit=true.
-- 2. Não pode ter saldo direto em siso_estoque pra kits (validado em wms_inserir_movimentacao).
-- 3. Estoque do kit é DERIVADO: MIN(disponivel_componente_i / qty_no_kit_i).
-- 4. Bipe de SKU de kit em inventário registra qty_no_kit unidades de cada componente.
-- 5. Saída (venda) de kit é "explodida" em saídas dos componentes (qty_componente × mov.quantidade).
-- 6. Kit não pode ser componente de outro kit (anti-recursão).

ALTER TABLE siso_produtos
  ADD COLUMN IF NOT EXISTS eh_kit boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN siso_produtos.eh_kit IS
  'Quando true, este SKU é um kit virtual cuja composição vive em siso_produto_kits. Não tem estoque próprio — derivado dos componentes.';

CREATE TABLE IF NOT EXISTS siso_produto_kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kit_produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE CASCADE,
  componente_produto_id uuid NOT NULL REFERENCES siso_produtos(id) ON DELETE RESTRICT,
  quantidade numeric(14,4) NOT NULL CHECK (quantidade > 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kit_produto_id, componente_produto_id),
  CHECK (kit_produto_id <> componente_produto_id)
);

CREATE INDEX IF NOT EXISTS siso_produto_kits_componente_idx
  ON siso_produto_kits(componente_produto_id);

COMMENT ON TABLE siso_produto_kits IS
  'Composição de kit virtual: kit_produto_id → componente_produto_id × quantidade.';

-- Anti-recursão: trigger garante que componente nunca seja um kit.
CREATE OR REPLACE FUNCTION wms_check_kit_componente_nao_kit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_eh_kit boolean;
BEGIN
  SELECT eh_kit INTO v_eh_kit FROM siso_produtos WHERE id = NEW.componente_produto_id;
  IF v_eh_kit THEN
    RAISE EXCEPTION 'Componente % é um kit — kits aninhados não são suportados', NEW.componente_produto_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_kit_componente_nao_kit ON siso_produto_kits;
CREATE TRIGGER trg_check_kit_componente_nao_kit
  BEFORE INSERT OR UPDATE ON siso_produto_kits
  FOR EACH ROW
  EXECUTE FUNCTION wms_check_kit_componente_nao_kit();

-- Função de cálculo do disponível derivado de um kit por par (empresa_dona, galpao).
-- Retorna disponível em "unidades de kit" — MIN(disponivel_componente / qty_no_kit).
CREATE OR REPLACE FUNCTION wms_kit_disponivel(
  p_kit_id uuid,
  p_empresa_dona_id uuid DEFAULT NULL,
  p_galpao_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  WITH composicao AS (
    SELECT pk.componente_produto_id, pk.quantidade AS qty_kit
    FROM siso_produto_kits pk
    WHERE pk.kit_produto_id = p_kit_id
  ),
  estoque_por_componente AS (
    SELECT
      c.componente_produto_id,
      c.qty_kit,
      COALESCE(SUM(e.disponivel), 0) AS disp
    FROM composicao c
    LEFT JOIN siso_estoque e
      ON e.produto_id = c.componente_produto_id
      AND (p_empresa_dona_id IS NULL OR e.empresa_dona_id = p_empresa_dona_id)
      AND (p_galpao_id IS NULL OR e.galpao_id = p_galpao_id)
    GROUP BY c.componente_produto_id, c.qty_kit
  )
  SELECT COALESCE(MIN(FLOOR(disp / qty_kit)), 0)::numeric
  FROM estoque_por_componente;
$$;

COMMENT ON FUNCTION wms_kit_disponivel(uuid, uuid, uuid) IS
  'Calcula quantos kits podem ser formados com o estoque disponível dos componentes. Filtros opcionais por empresa/galpão.';
