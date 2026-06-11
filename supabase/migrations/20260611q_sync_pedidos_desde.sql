-- Corte de sincronização de pedidos por empresa.
-- Quando uma empresa migra pro WMS, os pedidos anteriores à virada já foram
-- tratados pelo processo antigo (n8n). NULL = sem corte (comportamento atual:
-- janela de 7 dias do polling). Semântica de comparação (Tiny só expõe o DIA
-- de criação do pedido) em src/lib/sync-pedidos-corte.ts.
ALTER TABLE siso_empresas
  ADD COLUMN IF NOT EXISTS sync_pedidos_desde timestamptz;

COMMENT ON COLUMN siso_empresas.sync_pedidos_desde IS
  'Pedidos Tiny criados antes deste momento não entram no WMS (webhook ignora dia anterior ao corte; polling só puxa dias inteiramente pós-corte). NULL = sem corte.';
