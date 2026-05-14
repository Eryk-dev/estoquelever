-- WMS Mini-Swap Intra-Galpão — schema de configuração + RPC stub
-- Spec: docs/superpowers/specs/2026-05-14-mini-swap-intra-galpao-design.md

BEGIN;

-- 1. Tabela de configuração por galpão
CREATE TABLE IF NOT EXISTS siso_wms_mini_swap_config (
  galpao_id      uuid PRIMARY KEY REFERENCES siso_galpoes(id) ON DELETE CASCADE,
  ativo          boolean NOT NULL DEFAULT true,
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_por uuid REFERENCES siso_usuarios(id)
);

COMMENT ON TABLE siso_wms_mini_swap_config IS
  'Mini-swap intra-galpão: toggle on/off por galpão. Default ON pra galpões ativos no seed.';

-- 2. Seed: todos os galpões ativos
INSERT INTO siso_wms_mini_swap_config (galpao_id, ativo)
SELECT id, true FROM siso_galpoes WHERE ativo = true
ON CONFLICT (galpao_id) DO NOTHING;

-- 3. RPC stub — implementação real vem na Task 6
-- Recebe um plano jsonb pré-computado pelo TS, valida sob lock, aplica.
-- Stub retorna [] pra não quebrar quem chama (graceful degradation).
CREATE OR REPLACE FUNCTION wms_executar_mini_swap(
  p_plano       jsonb,
  p_pedido_ids  uuid[],
  p_galpao_id   uuid,
  p_usuario_id  uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  -- TODO Task 6: implementar algoritmo
  RETURN '[]'::jsonb;
END;
$$;

COMMENT ON FUNCTION wms_executar_mini_swap IS
  'Mini-swap intra-galpão: aplica plano pré-computado atomicamente sob lock pessimista. Retorna jsonb com movs criadas.';

COMMIT;
