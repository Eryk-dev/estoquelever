-- Separa permissão de empréstimo unidirecional e swap simétrico.
-- Antes: regra ativa = permite empréstimo (e implicitamente, swap).
-- Agora: regra pode permitir um, outro, ambos ou nenhum.
-- Defaults true em ambos pra retrocompat (regras existentes continuam
-- funcionando como antes; swap fica disponível por default).
BEGIN;

ALTER TABLE siso_emprestimo_regras
  ADD COLUMN IF NOT EXISTS permite_emprestimo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS permite_swap boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN siso_emprestimo_regras.permite_emprestimo IS
  'Se true, vendedora pode receber empréstimo unidirecional da credora (cria saldo devedor).';
COMMENT ON COLUMN siso_emprestimo_regras.permite_swap IS
  'Se true, par credora-devedora pode participar de swap simétrico (precisa flag true nas DUAS direções).';

COMMIT;
