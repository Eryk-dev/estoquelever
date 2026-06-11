-- 2026-05-19: cria empresa "Geral" como pool compartilhado pra inventário
-- multi-empresa. Bipes em sessões com empresa_dona_id = Geral funcionam sem
-- precisar atribuir cada SKU a uma empresa real (NetAir/NetParts/etc).
-- Roteamento via empréstimos/swaps será desenhado depois — por ora a Geral
-- funciona como placeholder de "dona indefinida".
--
-- Geral é preferencial em TODOS os galpões ativos pra aparecer no select do
-- modal de criação de inventário (filtrado por galpão). CNPJ sentinel
-- '00000000000000' é inválido e único — sinaliza que não é empresa Tiny real.
--
-- Trigger sync_empresa_galpao_id_from_preferenciais (migration 20260514)
-- popula automaticamente o campo legacy siso_empresas.galpao_id ao inserir
-- a primeira preferencial.

BEGIN;

INSERT INTO siso_empresas (nome, cnpj, ativo)
VALUES ('Geral', '00000000000000', true)
ON CONFLICT (cnpj) DO NOTHING;

INSERT INTO siso_empresa_galpoes_preferenciais (empresa_id, galpao_id)
SELECT e.id, g.id
FROM siso_empresas e
CROSS JOIN siso_galpoes g
WHERE e.cnpj = '00000000000000'
  AND g.ativo = true
ON CONFLICT (empresa_id, galpao_id) DO NOTHING;

COMMIT;
