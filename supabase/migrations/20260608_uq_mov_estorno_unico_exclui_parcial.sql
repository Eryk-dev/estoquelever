-- [P078] uq_mov_estorno_unico (P106) bloqueava estornos parciais múltiplos.
--
-- P106 (20260607) promoveu o índice de estorno a UNIQUE(estorno_de) como
-- backstop TOCTOU de FULL estorno ("cada mov só estornada uma vez"). Mas o
-- estorno PARCIAL (wms_estornar_parcial_movimentacao, 20260518) cria N linhas
-- de estorno por mov original — uma por chunk — todas com o mesmo estorno_de.
-- O índice blanket matava o 2º chunk com 23505 (uq_mov_estorno_unico), travando
-- o residual em reverterReplenishment e o desfazer-parcial de wave compartilhada.
--
-- Reconciliação: o índice passa a EXCLUIR estornos parciais
-- (origem_detalhes->>'parcial' = 'true'). O estorno parcial tem o SEU próprio
-- backstop atômico — o acumulador qty_estornada validado sob FOR UPDATE dentro
-- da RPC (qty_estornada + p_qty > quantidade → RAISE) — então não precisa do
-- UNIQUE. O full estorno (origem_detalhes sem 'parcial') continua single via
-- este índice; ledger.ts (estornarMovimentacao) ainda depende dele pra absorver
-- estorno concorrente como idempotente (23505 → recarrega).
--
-- ⚠️ PROD: siso_movimentacoes é a tabela de maior escrita (ledger). Em staging
-- (sem tráfego) o rebuild inline DROP/CREATE é instantâneo. Num prod populado,
-- rodar o DROP INDEX + CREATE UNIQUE INDEX como CONCURRENTLY (fora de transação,
-- sem o BEGIN/COMMIT) pra não travar escrita durante o build — mesma convenção
-- de 20260607_mov_estorno_unique.sql (P106). Cuidado: o DROP deixa uma janela
-- sem o backstop de unicidade enquanto o índice é reconstruído.

BEGIN;

DROP INDEX IF EXISTS uq_mov_estorno_unico;

CREATE UNIQUE INDEX uq_mov_estorno_unico
  ON siso_movimentacoes(estorno_de)
  WHERE estorno_de IS NOT NULL
    AND COALESCE(origem_detalhes->>'parcial', 'false') <> 'true';

COMMENT ON INDEX uq_mov_estorno_unico IS
  'P106/P078: cada mov só pode ter UM full estorno (UNIQUE parcial em estorno_de). Estornos parciais (origem_detalhes->>parcial=true) são excluídos — governados pelo acumulador qty_estornada sob FOR UPDATE na RPC.';

COMMIT;
