-- Cross — aposenta o legado (após rewire completo + seed).
-- Plano: docs/superpowers/plans/2026-06-19-cross-nucleo.md (Fase 5)
-- Ordem respeita FKs: oems/veiculos/links/verificadas referenciam catalogo
-- → dropar antes do catalogo. Nenhum FK externo aponta pra esses (verificado).

BEGIN;

DROP FUNCTION IF EXISTS public.siso_cross_cluster_skus(text);
DROP TABLE IF EXISTS siso_equivalencias_verificadas;
DROP TABLE IF EXISTS siso_produto_links;
DROP TABLE IF EXISTS siso_produto_oems;
DROP TABLE IF EXISTS siso_produto_veiculos;
DROP TABLE IF EXISTS siso_produtos_catalogo;

COMMIT;
