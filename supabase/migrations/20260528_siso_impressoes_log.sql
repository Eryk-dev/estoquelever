-- Fix-D #5.7: log persistente de jobs PrintNode pra retry manual.
--
-- Antes: print é fire-and-forget. Logs vão pra siso_erros mas operador
-- depende de toast volátil — perde alerta ao trocar tela.
-- Depois: cada job grava status (enviado/sucesso/erro) + payload ZPL pra
-- retry; UI tem aba /wms/etiquetas mostrando erros com botão Retry.

CREATE TABLE IF NOT EXISTS siso_impressoes_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  printnode_job_id bigint,
  printer_id bigint,
  printer_nome text,
  payload_zpl text NOT NULL,
  payload_hash text,
  contexto text NOT NULL,
  contexto_ref_id text,
  total_etiquetas int,
  status text NOT NULL DEFAULT 'enviado'
    CHECK (status IN ('enviado', 'sucesso', 'erro', 'cancelado')),
  erro_msg text,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  usuario_id uuid REFERENCES siso_usuarios(id) ON DELETE SET NULL,
  galpao_id uuid REFERENCES siso_galpoes(id) ON DELETE SET NULL,
  printnode_account_id uuid REFERENCES siso_printnode_contas(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_impressoes_log_status_enviado
  ON siso_impressoes_log (status, enviado_em DESC);
CREATE INDEX IF NOT EXISTS idx_impressoes_log_contexto
  ON siso_impressoes_log (contexto, contexto_ref_id);
CREATE INDEX IF NOT EXISTS idx_impressoes_log_galpao
  ON siso_impressoes_log (galpao_id, status);

COMMENT ON TABLE siso_impressoes_log IS
  'Fix-D #5.7: log de jobs PrintNode pra retry manual em falha.';
