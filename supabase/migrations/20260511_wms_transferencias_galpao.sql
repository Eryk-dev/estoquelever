-- Fluxo 2-etapas pra transferência inter-galpão:
-- 1) Origem cria transferência: gera S na loc origem (estoque já sai)
-- 2) Destino recebe: escolhe loc destino por item, gera E (estoque entra)
-- Cancelamento: estorna a S original.
-- Por que tabela separada vs movs órfãs: queremos um "header" com status,
-- audit de quem criou/recebeu, e permitir listar "a receber" no destino
-- sem ter que adivinhar pelas movs pendentes.
BEGIN;

CREATE TABLE IF NOT EXISTS siso_transferencias_galpao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_dona_id uuid NOT NULL REFERENCES siso_empresas(id),
  galpao_origem_id uuid NOT NULL REFERENCES siso_galpoes(id),
  galpao_destino_id uuid NOT NULL REFERENCES siso_galpoes(id),
  status text NOT NULL DEFAULT 'em_transito'
    CHECK (status IN ('em_transito','recebida','cancelada')),
  criada_por uuid NOT NULL REFERENCES siso_usuarios(id),
  criada_em timestamptz NOT NULL DEFAULT now(),
  recebida_por uuid REFERENCES siso_usuarios(id),
  recebida_em timestamptz,
  cancelada_por uuid REFERENCES siso_usuarios(id),
  cancelada_em timestamptz,
  observacoes text,
  CHECK (galpao_origem_id <> galpao_destino_id)
);

CREATE INDEX IF NOT EXISTS idx_transf_galpao_status
  ON siso_transferencias_galpao(status);
CREATE INDEX IF NOT EXISTS idx_transf_galpao_destino_pend
  ON siso_transferencias_galpao(galpao_destino_id)
  WHERE status = 'em_transito';
CREATE INDEX IF NOT EXISTS idx_transf_galpao_origem
  ON siso_transferencias_galpao(galpao_origem_id);

CREATE TABLE IF NOT EXISTS siso_transferencia_galpao_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transferencia_id uuid NOT NULL
    REFERENCES siso_transferencias_galpao(id) ON DELETE CASCADE,
  produto_id uuid NOT NULL REFERENCES siso_produtos(id),
  localizacao_origem_id uuid NOT NULL REFERENCES siso_localizacoes(id),
  qty numeric NOT NULL CHECK (qty > 0),
  localizacao_destino_id uuid REFERENCES siso_localizacoes(id),
  mov_saida_id uuid REFERENCES siso_movimentacoes(id),
  mov_entrada_id uuid REFERENCES siso_movimentacoes(id),
  mov_estorno_id uuid REFERENCES siso_movimentacoes(id),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transf_galpao_iten_transf
  ON siso_transferencia_galpao_itens(transferencia_id);
CREATE INDEX IF NOT EXISTS idx_transf_galpao_iten_produto
  ON siso_transferencia_galpao_itens(produto_id);

COMMIT;
