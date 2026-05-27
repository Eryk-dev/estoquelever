BEGIN;

-- Cria usuário sintético pra auto-atribuição de pedidos ML/Shopee no webhook.
-- vendedor_id em siso_pedidos passa a apontar pra esse user (em vez de NULL)
-- pra reports e visões "pedidos por vendedor" não perderem ML/Shopee.
-- ativo=false pra não aparecer em login/lista de operadores.
INSERT INTO siso_usuarios (nome, pin, cargo, ativo)
  VALUES ('system-marketplace', '0000', 'admin', false)
  ON CONFLICT (nome) DO NOTHING;

COMMIT;

-- DOWN: DELETE FROM siso_usuarios WHERE nome = 'system-marketplace';
