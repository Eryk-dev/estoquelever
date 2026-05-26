-- Marca soft-deprecation runtime de siso_empresas.galpao_id.
-- Coluna fica (UI admin lê pra mostrar preferencial), mas NENHUM consumer
-- de runtime crítico pode mais filtrar/decidir por ela.
-- O trigger sync_empresa_galpao_id_from_preferenciais continua mantendo o
-- espelho atualizado pra UI.
BEGIN;

COMMENT ON COLUMN siso_empresas.galpao_id IS
  'DEPRECATED (runtime) — espelho do 1º galpão preferencial mantido por trigger.'
  ' Não usar em decisões de negócio. Source of truth: siso_empresa_galpoes_preferenciais.'
  ' UI admin pode ler pra exibir o "preferencial principal" agregado.';

COMMIT;
