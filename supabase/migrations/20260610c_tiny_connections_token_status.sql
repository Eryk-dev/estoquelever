-- Migration: siso_tiny_connections — status real do token OAuth
-- Date: 2026-06-10
--
-- O painel de conexões mostrava "Autorizado" baseado só em access_token IS
-- NOT NULL — um refresh_token morto (invalid_grant, visto em NetAir/NetParts)
-- continuava aparecendo como saudável. Estas colunas persistem o resultado da
-- última tentativa de refresh (gravadas por tiny-oauth.getValidToken):
--
--   token_status      'ok' | 'erro' | NULL (nunca tentado desde a migration)
--   token_erro        mensagem da última falha (limpa no sucesso)
--   token_renovado_em timestamp do último refresh bem-sucedido
--
-- Rollback:
--   ALTER TABLE siso_tiny_connections
--     DROP COLUMN token_status, DROP COLUMN token_erro, DROP COLUMN token_renovado_em;

ALTER TABLE siso_tiny_connections
  ADD COLUMN IF NOT EXISTS token_status text CHECK (token_status IN ('ok', 'erro')),
  ADD COLUMN IF NOT EXISTS token_erro text,
  ADD COLUMN IF NOT EXISTS token_renovado_em timestamptz;

COMMENT ON COLUMN siso_tiny_connections.token_status IS 'Resultado da última renovação de token: ok | erro | NULL (nunca tentado)';
COMMENT ON COLUMN siso_tiny_connections.token_erro IS 'Mensagem da última falha de refresh (NULL após sucesso)';
COMMENT ON COLUMN siso_tiny_connections.token_renovado_em IS 'Timestamp do último refresh OAuth bem-sucedido';
