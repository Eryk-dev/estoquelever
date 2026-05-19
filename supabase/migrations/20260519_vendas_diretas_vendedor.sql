-- Adiciona suporte a "Vendas Diretas" (pedidos manuais inseridos por vendedor) +
-- identificação de vendedor (manual ou auto-atribuído para marketplaces ML/Shopee).
--
-- Decisões:
--  - `siso_pedidos.id` continua TEXT (Tiny ID); pedidos manuais usam prefixo "MAN-".
--  - `siso_pedido_itens.produto_id` (bigint, Tiny ID) é resolvido via lookup em
--    `siso_produto_empresas` no momento da criação manual — sem coluna nova.
--  - Whitelist do cargo "vendedor" é JS-only (VALID_CARGOS), sem CHECK no DB.

ALTER TABLE siso_pedidos
  ADD COLUMN IF NOT EXISTS vendedor_id uuid NULL REFERENCES siso_usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendedor_nome text NULL,
  ADD COLUMN IF NOT EXISTS origem_pedido text NOT NULL DEFAULT 'webhook',
  ADD COLUMN IF NOT EXISTS canal_venda text NULL;

-- Constraint de origem_pedido (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'siso_pedidos_origem_pedido_chk'
  ) THEN
    ALTER TABLE siso_pedidos
      ADD CONSTRAINT siso_pedidos_origem_pedido_chk
      CHECK (origem_pedido IN ('webhook','manual'));
  END IF;
END $$;

COMMENT ON COLUMN siso_pedidos.vendedor_id IS 'FK opcional pra usuário vendedor responsável pelo pedido (NULL pra marketplaces).';
COMMENT ON COLUMN siso_pedidos.vendedor_nome IS 'Nome do vendedor (denormalizado). Pra ML/Shopee = "{nome_ecommerce} {empresa}".';
COMMENT ON COLUMN siso_pedidos.origem_pedido IS 'webhook = veio do Tiny/marketplace. manual = inserido por vendedor no /wms/vendas.';
COMMENT ON COLUMN siso_pedidos.canal_venda IS 'Canal pra pedido manual: Balcão/WhatsApp/Telefone/Outro. NULL pra webhook.';

CREATE INDEX IF NOT EXISTS idx_pedidos_vendedor_id ON siso_pedidos(vendedor_id)
  WHERE vendedor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_vendas_diretas
  ON siso_pedidos(status, criado_em DESC)
  WHERE origem_pedido = 'manual'
     OR nome_ecommerce IN ('Mercado Livre','Shopee');
