-- Fase 2.3 — DROP das colunas legadas 2-galpão de siso_pedido_itens.
-- Herdadas do schema pré-WMS (estoque hardcoded a CWB|SP). Estoque hoje é 3D
-- (produto × galpão × localização) em siso_estoque. grep provou ZERO leitura no
-- código; writes mortos removidos (tiny/stock/ajustar + webhook-processor-wms);
-- cwb_atende/sp_atende já não eram escritos desde Fix-D T10. Nenhuma função PG,
-- view ou trigger referencia estas colunas (verificado via pg_proc/views).
ALTER TABLE siso_pedido_itens
  DROP COLUMN IF EXISTS estoque_cwb_saldo,
  DROP COLUMN IF EXISTS estoque_cwb_reservado,
  DROP COLUMN IF EXISTS estoque_cwb_disponivel,
  DROP COLUMN IF EXISTS estoque_cwb_deposito_id,
  DROP COLUMN IF EXISTS estoque_cwb_deposito_nome,
  DROP COLUMN IF EXISTS estoque_sp_saldo,
  DROP COLUMN IF EXISTS estoque_sp_reservado,
  DROP COLUMN IF EXISTS estoque_sp_disponivel,
  DROP COLUMN IF EXISTS estoque_sp_deposito_id,
  DROP COLUMN IF EXISTS estoque_sp_deposito_nome,
  DROP COLUMN IF EXISTS cwb_atende,
  DROP COLUMN IF EXISTS sp_atende,
  DROP COLUMN IF EXISTS localizacao_cwb,
  DROP COLUMN IF EXISTS localizacao_sp;
