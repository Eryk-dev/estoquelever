-- Habilita Supabase Realtime nas tabelas de saldo + ledger pra que a UI
-- de /wms/pedidos reaja a movimentações de estoque em tempo real.
--
-- CLAUDE.md já documentava essas tabelas como parte da publication, mas
-- a publication estava incompleta no banco (provavelmente perdida em
-- algum DROP/CREATE TABLE da fase ledger-simplificado 3D).

ALTER PUBLICATION supabase_realtime ADD TABLE siso_estoque;
ALTER PUBLICATION supabase_realtime ADD TABLE siso_movimentacoes;
