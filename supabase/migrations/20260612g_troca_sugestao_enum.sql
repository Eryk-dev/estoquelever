-- Troca de Equivalência (fase roteamento): pedido cuja cobertura só fecha com
-- substituto que EXIGE aprovação cai 'pendente' com sugestao='troca_equivalente'
-- (painel mostra o modal de troca em vez do fluxo de transferência).
--
-- O enum siso_decisao é compartilhado por siso_pedidos.sugestao e
-- decisao_final — adicionar valor é safe (mesmo racional da migration
-- 20260527_decisao_final_rejeitado).
--
-- Nota: ALTER TYPE ... ADD VALUE não roda dentro de transaction block —
-- arquivo sem BEGIN/COMMIT.

ALTER TYPE siso_decisao ADD VALUE IF NOT EXISTS 'troca_equivalente';
