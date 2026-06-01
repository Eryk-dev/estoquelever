-- Acerto de prateleira no pick (Fase 1) — fix da acuracidade (D2)
-- wms_metricas_operador ainda fazia JOIN em siso_inventario_divergencias.empresa_dona_id
-- = siso_inventario_contagens.empresa_dona_id, mas essas colunas foram DROPADAS no
-- ledger simplificado 3D (2026-05-20). A RPC estava quebrada (referência a coluna
-- inexistente). Como a contagem inline do pick depende dela pra "entrar na acuracidade"
-- (D2), migramos o JOIN pra 3D (sessao + loc + produto — que é o unique real de
-- siso_inventario_divergencias).

CREATE OR REPLACE FUNCTION public.wms_metricas_operador()
RETURNS TABLE (
  operador_id uuid,
  nome text,
  contagens int,
  erro_medio_pct numeric
) LANGUAGE sql AS $$
  SELECT
    u.id AS operador_id,
    u.nome,
    COUNT(DISTINCT c.id)::int AS contagens,
    AVG(ABS(d.delta_pct)) FILTER (WHERE d.id IS NOT NULL) AS erro_medio_pct
  FROM siso_inventario_contagens c
  JOIN siso_usuarios u ON u.id = c.contada_por
  LEFT JOIN siso_inventario_divergencias d
    ON d.sessao_id = c.sessao_id
   AND d.localizacao_id = c.localizacao_id
   AND d.produto_id = c.produto_id
  WHERE c.criado_em >= now() - interval '30 days'
  GROUP BY u.id, u.nome
  ORDER BY 4 DESC NULLS LAST;
$$;
