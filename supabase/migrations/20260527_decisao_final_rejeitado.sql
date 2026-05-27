-- Plano P6 Task D.4 — Recusar real
--
-- Adiciona o valor 'rejeitado' ao enum siso_decisao para permitir que
-- /api/wms/pedidos/aprovar registre rejeição explícita via decisao_final
-- (em vez de só atualizar status='cancelado' sem rastro da decisão tomada).
--
-- O enum siso_decisao é usado em duas colunas (siso_pedidos.sugestao e
-- siso_pedidos.decisao_final). Adicionar valor é safe — colunas existentes
-- continuam válidas, e o frontend só envia 'rejeitado' explicitamente para
-- decisao_final via o botão Recusar.
--
-- Nota: ALTER TYPE ... ADD VALUE não pode rodar dentro de transaction block.
-- Por isso este arquivo não tem BEGIN/COMMIT.

ALTER TYPE siso_decisao ADD VALUE IF NOT EXISTS 'rejeitado';
