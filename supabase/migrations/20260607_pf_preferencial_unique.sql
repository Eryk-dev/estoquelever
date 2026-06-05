-- P124/P125 — converte idx_pf_preferencial (não-único, 20260522_wms_roteamento.sql:45)
-- em UNIQUE parcial: no máximo 1 fornecedor preferencial ativo por produto.
-- Backstop de banco contra a corrida da troca em 2 statements (PATCH despromove+promove).
--
-- Pré-dedup: se já existe produto com >1 preferencial ativo, o CREATE UNIQUE falha.
-- Limpa antes mantendo só o vínculo mais recente como preferencial.

BEGIN;

-- Dedup defensivo: para produtos com >1 preferencial ativo, mantém só o
-- mais recente (criado_em DESC) e despromove os demais.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY produto_id ORDER BY criado_em DESC, id DESC) AS rn
  FROM siso_produto_fornecedores
  WHERE preferencial = true AND ativo = true
)
UPDATE siso_produto_fornecedores pf
   SET preferencial = false
  FROM ranked r
 WHERE pf.id = r.id AND r.rn > 1;

DROP INDEX IF EXISTS idx_pf_preferencial;

CREATE UNIQUE INDEX idx_pf_preferencial
  ON siso_produto_fornecedores(produto_id)
  WHERE preferencial AND ativo;

COMMENT ON INDEX idx_pf_preferencial IS
  'P124: no máximo 1 fornecedor preferencial ativo por produto (UNIQUE parcial).';

COMMIT;
