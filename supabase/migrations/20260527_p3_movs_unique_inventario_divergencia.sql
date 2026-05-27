-- P3 fix #4.1: idempotência de aplicar inventário.
-- Cada divergência aprovada vira NO MÁXIMO 1 mov no ledger (E ou S).
-- Clique duplo no botão "Aplicar" passa a falhar com SQLSTATE 23505 no
-- 2º clique em vez de duplicar movs.
--
-- Índice parcial: cobre apenas movs onde origem_detalhes carrega
-- divergencia_id (formato pós-P3). Movs históricas sem essa chave ficam
-- fora do enforcement e dependem do cleanup retroativo (P6).
--
-- IMPORTANTE: este migration assume que Task 6 detectou zero duplicatas.
-- Se rodar com duplicatas, falha com "could not create unique index" —
-- isso é proteção, não bug.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_movs_inventario_divergencia
  ON siso_movimentacoes ((origem_detalhes->>'divergencia_id'))
  WHERE origem_tipo IN ('inventario_ganho', 'inventario_perda')
    AND origem_detalhes ? 'divergencia_id';

COMMENT ON INDEX uniq_movs_inventario_divergencia IS
  'P3 #4.1: garante 1 mov por divergência aplicada (idempotência do aplicarSessao).';
