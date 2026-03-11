CREATE TABLE IF NOT EXISTS siso_configuracoes (
  chave text PRIMARY KEY,
  valor text NOT NULL,
  atualizado_em timestamptz DEFAULT now()
);

COMMENT ON TABLE siso_configuracoes IS 'Key-value config store for system settings (e.g., PrintNode API key)';
