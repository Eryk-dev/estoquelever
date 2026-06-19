-- Cross — seed: migra pares já validados na troca pro caderno novo.
-- Só pares cujos DOIS skus existem em siso_produtos (FK do caderno).
-- Plano: docs/superpowers/plans/2026-06-19-cross-nucleo.md (Fase 3)

BEGIN;

INSERT INTO siso_cross_equivalencias
  (sku_a, sku_b, relacao, status, fonte, observacao, decidido_por, decidido_em, criado_em)
SELECT
  v.sku_a,
  v.sku_b,
  'equivalente',
  CASE v.status WHEN 'verificado' THEN 'confirmado' ELSE 'bloqueado' END,
  'migracao_troca',
  v.observacao,
  v.verificado_por,
  v.verificado_em,
  v.verificado_em
FROM siso_equivalencias_verificadas v
WHERE EXISTS (SELECT 1 FROM siso_produtos p WHERE p.sku = v.sku_a)
  AND EXISTS (SELECT 1 FROM siso_produtos p WHERE p.sku = v.sku_b)
ON CONFLICT (sku_a, sku_b) DO NOTHING;

COMMIT;
