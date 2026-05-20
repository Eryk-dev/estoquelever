-- Drop empresa_dona_id de siso_transferencias_galpao.
--
-- Contexto: Batch 5-B do refactor "ledger simplificado 3D" removeu empresa
-- da chave de coordenada de estoque. O lib refactor de transferencias.ts
-- (commit 3090b56) já parou de incluir empresa_dona_id no INSERT do
-- header, mas a coluna ainda era NOT NULL no DB — o que quebraria qualquer
-- chamada em runtime com "null value in column empresa_dona_id violates
-- not-null constraint".
--
-- Esta migration apenas dropa a coluna do header `siso_transferencias_galpao`.
-- Outras tabelas que ainda têm `empresa_dona_id` serão tratadas em batches
-- subsequentes.

ALTER TABLE siso_transferencias_galpao DROP COLUMN IF EXISTS empresa_dona_id;
