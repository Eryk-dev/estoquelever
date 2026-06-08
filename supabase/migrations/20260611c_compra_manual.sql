-- Compra manual de fornecedor (compra avulsa, sem pedido de cliente).
-- Aggregate dedicado: cabeçalho + itens. O movimento de entrada reusa
-- origem_tipo='nf_compra' (whitelist de custo médio) distinguido por
-- origem_detalhes.origem='compra_manual'. Acesso só via service role (sem RLS,
-- consistente com as demais tabelas operacionais siso_*).
BEGIN;

CREATE TABLE IF NOT EXISTS siso_compras_manuais (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id         uuid NOT NULL REFERENCES siso_fornecedores(id),
  empresa_compradora_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_id             uuid NOT NULL REFERENCES siso_galpoes(id),
  status                text NOT NULL DEFAULT 'comprado'
                          CHECK (status IN ('comprado','parcial','recebido','cancelado')),
  observacao            text,
  criado_por            uuid REFERENCES siso_usuarios(id),
  criado_em             timestamptz NOT NULL DEFAULT now(),
  recebido_em           timestamptz
);

CREATE TABLE IF NOT EXISTS siso_compras_manuais_itens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id      uuid NOT NULL REFERENCES siso_compras_manuais(id) ON DELETE CASCADE,
  produto_id     uuid NOT NULL REFERENCES siso_produtos(id),
  qty_comprada   numeric NOT NULL CHECK (qty_comprada > 0),
  qty_recebida   numeric NOT NULL DEFAULT 0 CHECK (qty_recebida >= 0),
  custo_unitario numeric,
  CHECK (qty_recebida <= qty_comprada)
);

CREATE INDEX IF NOT EXISTS idx_compras_manuais_status ON siso_compras_manuais(status);
CREATE INDEX IF NOT EXISTS idx_compras_manuais_itens_compra ON siso_compras_manuais_itens(compra_id);
CREATE INDEX IF NOT EXISTS idx_compras_manuais_itens_produto ON siso_compras_manuais_itens(produto_id);

COMMIT;
