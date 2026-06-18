-- Fecha o buraco do índice único de OC aberta.
--
-- 20260611p_oc_unique_aberta.sql criou `uq_oc_aberta_fornecedor_galpao` parcial,
-- que só cobre OCs com galpao_id NÃO-nulo. O caminho de fallback por empresa
-- (galpao_id nulo) ficava DESPROTEGIDO → 2 requests concorrentes podiam duplicar
-- a OC aberta do mesmo (fornecedor, empresa).
--
-- Segundo índice parcial cobre exatamente esse caso (galpao_id IS NULL), pra o
-- 23505 disparar e o find-or-create race-safe (`findOrCreateOcAberta`) reusar a
-- vencedora.

CREATE UNIQUE INDEX IF NOT EXISTS uq_oc_aberta_fornecedor_empresa
  ON siso_ordens_compra (fornecedor, empresa_id)
  WHERE status = 'aguardando_compra' AND galpao_id IS NULL;
